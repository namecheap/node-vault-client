'use strict';

const _ = require('lodash');
const Lease = require('./Lease');
const errors = require('./errors');
const VaultApiClient = require('./VaultApiClient');
const VaultAppRoleAuth = require('./auth/VaultAppRoleAuth');
const VaultTokenAuth = require('./auth/VaultTokenAuth');
const VaultIAMAuth = require('./auth/VaultIAMAuth');
const VaultNodeConfig = require('./VaultNodeConfig');
const VaultKubernetesAuth = require('./auth/VaultKubernetesAuth');
const MountResolver = require('./MountResolver');
const { rewritePath, normalizeResponse } = require('./kvTransform');
const safeMessage = require('./safeMessage');
const { trimTrailingSlashes } = require('./slashes');
const vaultInstances = {};

// The URL parser and Vault reinterpret these: '?' starts the query, '#' the fragment, '\' is a
// path separator for http(s), and tab/LF/CR and trailing C0 controls or spaces are dropped. Any
// of them lets a KV path address a different key.
// eslint-disable-next-line no-control-regex
const UNSAFE_KV_PATH_CHARS = /[?#\\\u0000-\u001f\u007f]/;
// An unpaired surrogate (String.prototype.isWellFormed() needs Node 20; this line supports 14+).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Rejects a KV method path that the URL parser or Vault would resolve to a path other than
 * `<mount>/<kv segment>/<logical path>` (GHSA-rr65-m54w-rfr9, GHSA-wf8v-q2h3-hgjm).
 *
 * Vault removes '.' and '..' segments and redirects, which `request` follows with the token, and
 * url-join collapses an empty segment ('tenants//key' becomes 'tenants/key') before the request
 * is sent. Encoded forms are rejected rather than decoded: Vault decodes %2e and %2f before it
 * resolves '..', and Vault 2.x decodes again on every redirect hop, so a %25-encoded escape
 * becomes %2e or %2f on the first hop and a real dot segment or separator on the second. No other
 * escape can form a dot segment or a separator, so the segments are then checked as written.
 *
 * The messages never include the path: the KV methods log them at error level, and the path
 * may be built from user data that was never logged before.
 *
 * The mount (first segment) must not be percent-encoded: the engines override and mount
 * detection match the path as written, but Vault decodes it.
 *
 * @param {*} path - caller-supplied secret path
 * @returns {string} the path without leading slashes; resolving the mount on it keeps the KV v2
 *      rewrite from taking '/secret/foo' for a key in 'secret/'
 * @throws {InvalidArgumentsError}
 * @private
 */
function assertSafeKvPath(path) {
    if (typeof path !== 'string' || path === '') {
        throw new errors.InvalidArgumentsError('Invalid secret path: expected a non-empty string');
    }
    if (UNSAFE_KV_PATH_CHARS.test(path) || path.endsWith(' ') || LONE_SURROGATE.test(path)) {
        throw new errors.InvalidArgumentsError(
            'Invalid secret path: \'?\', \'#\', \'\\\', control characters, unpaired surrogates and a ' +
            'trailing space are not allowed'
        );
    }
    if (/%(2e|2f|5c|25)/i.test(path)) {
        throw new errors.InvalidArgumentsError(
            'Invalid secret path: encoded dots, separators or percent signs are not allowed'
        );
    }
    const trimmed = path.replace(/^\/+/, '');
    if (trimmed.split('/')[0].includes('%')) {
        throw new errors.InvalidArgumentsError('Invalid secret path: the mount must not be percent-encoded');
    }
    // One trailing slash is allowed: list() addresses a folder with it.
    const segments = trimmed.replace(/\/$/, '').split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new errors.InvalidArgumentsError(
            'Invalid secret path: empty, \'.\' and \'..\' segments are not allowed'
        );
    }
    return trimmed;
}

class VaultClient {

    /**
     * Client constructor function.
     *
     * @param {Object} options
     * @param {Object} options.api
     * @param {String} options.api.url - the url of the vault server
     * @param {String} [options.api.apiVersion='v1']
     * @param {Object} [options.api.kv] - KV engine options
     * @param {boolean} [options.api.kv.autoDetect=false] - When true, auto-detect the KV version per mount
     *      via a `sys/internal/ui/mounts/<path>` round-trip. When false (default) no detection call is
     *      ever made and read/list/write behave byte-for-byte as before unless an engine is
     *      listed in `options.api.engines`.
     * @param {Object} [options.api.engines] - Static mount-to-version overrides, e.g. `{ secret: 2, legacy: 1 }`.
     *      Listed mounts resolve without any detection round-trip (works even with autoDetect off), making
     *      this a reliable fallback for Vaults that deny the detection endpoint.
     * @param {Object} options.auth
     * @param {String} options.auth.type
     * @param {Object} options.auth.config - auth configuration variables
     * @param {Object|false} options.logger - Logger that implements all five of "error", "warn", "info", "debug"
     *      and "trace"; one missing any of them is silently replaced by the default logger. The default logger
     *      writes to `console`, except "debug", which is discarded. Pass `false` to disable logging.
     */
    constructor(options) {
        this.__log = this.__setupLogger(options.logger);

        this.__api = new VaultApiClient(
            options.api,
            this.__log
        );

        /**
         * @type {VaultBaseAuth}
         * @private
         */
        this.__auth = this.__getAuthProvider(
            options.auth,
            this.__api
        );

        this.__namespace = options.auth.config.namespace;

        // KV v2 support (opt-in, non-breaking).
        const kvOpts = (options.api && options.api.kv) || {};
        const autoDetect = kvOpts.autoDetect === true;
        const engines = (options.api && options.api.engines) || {};

        // Detection (the sys/internal/ui/mounts round-trip) only happens when
        // autoDetect is on. With engines set but autoDetect off, listed mounts use
        // the override and any other mount is passthrough (v1) — no detection call
        // is ever made. This keeps the default byte-for-byte and makes engines a
        // working fallback for Vaults that deny the detection endpoint.
        const resolverDisabled = !autoDetect;

        // Build detectFn lazily — it uses __auth and __api which are already set above.
        const detectFn = (path) => this.__detectMount(path);

        this.__resolver = new MountResolver(detectFn, engines, this.__log, {
            disabled: resolverDisabled,
            namespace: this.__namespace,
        });
    }

    /**
     * Boot an instance of Vault
     *
     * The instance will be stored in a local hash. Calling Vault.boot multiple
     * times with the same name will return the same instance.
     *
     * @param {String} name - Vault instance name
     * @param {Object} [options] - options for {@link Vault#constructor}.
     * @return Vault
     */
    static boot(name, options) {
        if (options === undefined) {
            throw new errors.InvalidArgumentsError('Options should be provided');
        }

        let instance = vaultInstances[name];
        if (instance === undefined) {
            vaultInstances[name] = instance = new VaultClient(options);
        }
        return instance;
    }

    /**
     * Get an instance of Vault
     *
     * The instance will be stored in a local hash. Calling Vault.pop multiple
     * times with the same name will return the same instance.
     *
     * @param {String} name - Vault instance name
     * @return Vault
     */
    static get(name) {
        let instance = vaultInstances[name];

        if (instance === undefined) {
            throw new errors.InvalidArgumentsError('Invalid instance name');
        }

        return instance;
    }

    /**
     * Clear named Vault instance
     *
     * If no name passed all named instances will be cleared.
     *
     * @param {String} [name] - Vault instance name, all instances will be cleared if no name were passed
     */
    static clear(name) {
        if (typeof name === 'string') {
            delete vaultInstances[name];
        } else {
            for (let k in vaultInstances) {
                if (vaultInstances.hasOwnProperty(k)) {
                    delete vaultInstances[k];
                }
            }
        }
    }

    /**
     * @protected
     *
     * @param {Object} authConfig
     * @param {string} authConfig.type
     * @param {string} authConfig.mount
     * @param {Object} authConfig.config
     * @param {VaultApiClient} api
     * @return {VaultBaseAuth}
     * @private
     */
    __getAuthProvider(authConfig, api) {
        this.__log.debug('creating vault auth method: "%s"', authConfig.type);

        switch (authConfig.type) {
            case 'iam':
                return new VaultIAMAuth(
                    api,
                    this.__log,
                    authConfig.config,
                    authConfig.mount
                );
            case 'appRole':
                return new VaultAppRoleAuth(
                    api,
                    this.__log,
                    authConfig.config,
                    authConfig.mount
                );
            case 'token':
                return new VaultTokenAuth(
                    api,
                    this.__log,
                    authConfig.config,
                    authConfig.mount
                );
            case 'kubernetes':
                return new VaultKubernetesAuth(
                    api,
                    this.__log,
                    authConfig.config,
                    authConfig.mount
                );
        }

        throw new errors.InvalidArgumentsError('Unsupported auth method')
    }

    /**
     * Populates Vault's values to NPM "config" module
     */
    fillNodeConfig() {
        const vaultConf = new VaultNodeConfig(this);

        return vaultConf.populate();
    }

    getHeaders(token) {
        if (this.__namespace) {
            return {
                'X-Vault-Token': token.getId(),
                'X-Vault-Namespace': this.__namespace
            }
        }

        return {'X-Vault-Token': token.getId()}
    }

    // -------------------------------------------------------------------------
    // Detection helper (used by MountResolver's detectFn)
    // -------------------------------------------------------------------------

    /**
     * Calls GET sys/internal/ui/mounts/<path> with the current auth token.
     * Returns the parsed Vault response body.
     * @private
     */
    __detectMount(path) {
        return this.__auth.getAuthToken()
            .then((token) => {
                const detectPath = `sys/internal/ui/mounts/${path}`;
                return this.__api.makeRequest('GET', detectPath, null, this.getHeaders(token));
            });
    }

    // -------------------------------------------------------------------------
    // Internal resolve + request helper
    // -------------------------------------------------------------------------

    /**
     * Resolve the mount version for a path, rewrite the path, make the request,
     * and return a { apiPath, body, version, mount } object.
     *
     * When the resolver is disabled (autoDetect:false, no matching engine), it
     * preserves the caller's literal path byte-for-byte, keeping behaviour
     * identical to the pre-KV-v2 client.
     *
     * @private
     */
    __resolveAndRequest(op, method, path, data) {
        // KV paths are validated before the token fetch, mount resolution and the autoDetect
        // detection request (GHSA-rr65-m54w-rfr9).
        try {
            path = assertSafeKvPath(path);
        } catch (err) {
            return Promise.reject(err);
        }

        return this.__auth.getAuthToken()
            .then((token) => {
                const headers = this.getHeaders(token);

                return this.__resolver.resolve(path)
                    .then((resolved) => {
                        const mount = resolved.mount;
                        const version = resolved.version;
                        let apiPath;
                        let requestData = data;

                        if (version === 2) {
                            // Split the path into mount + logical sub-path and rewrite for KV v2
                            const logicalPath = this.__logicalPath(path, mount);
                            apiPath = rewritePath(version, op, mount, logicalPath);
                            // Wrap data in { data: ... } on v2 writes
                            if (op === 'write' && data !== null && data !== undefined) {
                                requestData = { data };
                            }
                        } else {
                            // v1 / disabled: preserve the caller's literal path byte-for-byte,
                            // including any trailing slash, to maintain the old wire behaviour.
                            apiPath = path;
                        }

                        return this.__api.makeRequest(method, apiPath, requestData, headers)
                            .then((body) => ({ body, version, mount, apiPath }));
                    });
            });
    }

    /**
     * Extract the logical path after the mount prefix.
     * e.g. path='secret/foo/bar', mount='secret' => 'foo/bar'
     * @private
     */
    __logicalPath(path, mount) {
        const prefix = trimTrailingSlashes(mount);
        if (path === prefix) return '';
        if (path.startsWith(prefix + '/')) return path.slice(prefix.length + 1);
        // Detection decodes the path, so with a multi-segment mount 'team/k%76/foo' resolves to
        // 'team/kv'; rewriting it as a key inside that mount would address 'team/kv/team/kv/foo'
        // (GHSA-rr65-m54w-rfr9). MountResolver.resolve() already rejects that; this guards the
        // rewrite itself.
        throw new errors.InvalidArgumentsError(
            `Invalid secret path: it does not start with the mount "${prefix}" it resolved to; ` +
            'do not percent-encode the mount'
        );
    }

    /**
     * Read secret from Vault
     * @param {string} path - path to the secret
     * @returns {Promise<Lease>}
     */
    read(path) {
        this.__log.debug('read secret %s', path);
        return this.__resolveAndRequest('read', 'GET', path, null)
            .then(({ body, version }) => {
                this.__log.debug('receive secret %s', path);
                const normalised = normalizeResponse(version, 'read', body);
                return Lease.fromResponse(normalised);
            })
            .catch((reason) => {
                this.__log.error('read secret failed: %s', safeMessage(reason));
                throw reason;
            });
    }

    /**
     * Retrieves secrets list
     *
     * @param {string} path - path to the secret
     * @returns {Promise<Lease>}
     */
    list(path) {
        this.__log.debug('list secrets %s', path);
        return this.__resolveAndRequest('list', 'LIST', path, null)
            .then(({ body, version }) => {
                this.__log.debug('got secrets list %s', path);
                const normalised = normalizeResponse(version, 'list', body);
                return Lease.fromResponse(normalised);
            })
            .catch((reason) => {
                this.__log.error('list secrets failed: %s', safeMessage(reason));
                throw reason;
            });
    }

    /**
     * Writes data to Vault
     *
     * @param path - path used to write data
     * @param {object} data - data to write
     * @returns {Promise<T | never>}
     */
    write(path, data) {
        this.__log.debug('write secret %s', path);
        return this.__resolveAndRequest('write', 'POST', path, data)
            .then(({ body }) => {
                this.__log.debug('secret %s was written', path);
                return body;
            })
            .catch((reason) => {
                this.__log.error('write secret failed: %s', safeMessage(reason));
                throw reason;
            });
    }

    /**
     * @private
     */
    __setupLogger(logger) {
        if (logger === false) {
            return {
                error: _.noop,
                warn: _.noop,
                info: _.noop,
                debug: _.noop,
                trace: _.noop,
            }
        } else if (_.intersection(_.functionsIn(logger), ['error', 'warn', 'info', 'debug', 'trace']).length >= 5) {
            return logger
        } else {
            return {
                error: console.error,
                warn: console.warn,
                info: console.info,
                trace: console.trace,
                // avoid output sensitive information
                debug: _.noop
            };
        }
    }
}

module.exports = VaultClient;
