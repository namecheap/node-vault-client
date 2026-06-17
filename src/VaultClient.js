'use strict';

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

const noop = () => {};
const vaultInstances = {};

class VaultClient {

    /**
     * Client constructor function.
     *
     * @param {Object} options
     * @param {Object} options.api
     * @param {String} options.api.url - the url of the vault server
     * @param {String} [options.api.apiVersion='v1']
     * @param {Object} [options.api.requestOptions] - extra options merged into every HTTP
     *      request (e.g. an undici `dispatcher` for a proxy/SOCKS agent or custom TLS/CA trust).
     *      See {@link VaultApiClient#constructor}.
     * @param {Object} [options.api.kv] - KV engine options
     * @param {boolean} [options.api.kv.autoDetect=false] - When true, auto-detect KV version per mount
     * @param {Object} [options.api.engines] - Mount-to-version overrides, e.g. { secret: 2, legacy: 1 }
     * @param {Object} options.auth
     * @param {String} options.auth.type
     * @param {Object} options.auth.config - auth configuration variables
     * @param {Object|false} options.logger - Logger that supports "error", "info", "warn", "trace", "debug" methods. Uses `console` by default. Pass `false` to disable logging.
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

        // KV v2 support
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
        });
    }

    /**
     * Boot an instance of Vault
     *
     * The instance will be stored in a local hash. Calling Vault.boot multiple
     * times with the same name will return the same instance.
     *
     * @param {String} name - Vault instance name
     * @param {Object} [options] - options for {@link VaultClient#constructor}.
     * @return {VaultClient}
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
     * @return {VaultClient}
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
            const instance = vaultInstances[name];
            if (instance !== undefined) {
                instance.close();
                delete vaultInstances[name];
            }
        } else {
            for (let k in vaultInstances) {
                if (Object.hasOwn(vaultInstances, k)) {
                    vaultInstances[k].close();
                    delete vaultInstances[k];
                }
            }
        }
    }

    /**
     * Release resources held by this client.
     *
     * Cancels the background auth-token refresh timer that keeps the Node.js event loop
     * alive for renewable tokens. Call this once you are done with the client so a
     * short-lived script can exit on its own. Safe to call when no timer is armed and
     * safe to call multiple times. After calling `close()` the client may still be used;
     * the next operation that fetches a renewable token will arm a new refresh timer.
     *
     * @returns {void}
     */
    close() {
        if (this.__auth && typeof this.__auth.cancelTokenRefresh === 'function') {
            this.__auth.cancelTokenRefresh();
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
     * and normalise the response.  Returns a { apiPath, body, version, mount } object.
     *
     * When the resolver is disabled (autoDetect:false, no engines), it skips
     * resolution and passes through raw, preserving identical behavior to before.
     *
     * @private
     */
    __resolveAndRequest(op, method, path, data, extraHeaders) {
        return this.__auth.getAuthToken()
            .then((token) => {
                const headers = Object.assign({}, this.getHeaders(token), extraHeaders || {});

                return this.__resolver.resolve(path)
                    .then(({ mount, version }) => {
                        let apiPath;
                        let requestData = data;

                        if (version === 2) {
                            // Split the path into mount + logical sub-path and rewrite for KV v2
                            const logicalPath = this.__logicalPath(path, mount);
                            apiPath = rewritePath(version, op, mount, logicalPath);
                            // Wrap data in { data: ... } on v2 write/update
                            if ((op === 'write' || op === 'update') && data !== null && data !== undefined) {
                                requestData = { data };
                            }
                        } else {
                            // v1 / disabled: preserve the caller's literal path byte-for-byte,
                            // including any trailing slash, to maintain the old wire behavior.
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
        const prefix = mount.replace(/\/+$/, '');
        if (path === prefix) return '';
        if (path.startsWith(prefix + '/')) return path.slice(prefix.length + 1);
        return path;
    }

    // -------------------------------------------------------------------------
    // Public API — existing methods (with KV v2 awareness)
    // -------------------------------------------------------------------------

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
                this.__log.error('read secret failed: %s', reason.message);
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
                this.__log.error('list secrets failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * Writes data to Vault
     *
     * @param {string} path - path used to write data
     * @param {object} data - data to write
     * @returns {Promise<Object>} the parsed Vault response body
     */
    write(path, data) {
        this.__log.debug('write secret %s', path);
        return this.__resolveAndRequest('write', 'POST', path, data)
            .then(({ body }) => {
                this.__log.debug('secret %s was written', path);
                return body;
            })
            .catch((reason) => {
                this.__log.error('write secret failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * Delete (soft-delete latest version) a secret.
     *
     * On KV v1 / non-kv mounts this sends DELETE to the raw path.
     * On KV v2 mounts this sends DELETE to the data/ path, soft-deleting the latest version.
     *
     * @param {string} path
     * @returns {Promise<Object>}
     */
    delete(path) {
        this.__log.debug('delete secret %s', path);
        return this.__resolveAndRequest('delete', 'DELETE', path, null)
            .then(({ body }) => {
                this.__log.debug('secret %s was deleted', path);
                return body;
            })
            .catch((reason) => {
                this.__log.error('delete secret failed: %s', reason.message);
                throw reason;
            });
    }

    // -------------------------------------------------------------------------
    // New methods
    // -------------------------------------------------------------------------

    /**
     * PATCH (update) a KV v2 secret using merge-patch semantics.
     * Sends the data wrapped in { data: ... } with Content-Type: application/merge-patch+json.
     *
     * @param {string} path
     * @param {object} data
     * @returns {Promise<Object>}
     */
    update(path, data) {
        this.__log.debug('update (patch) secret %s', path);
        const patchHeaders = { 'Content-Type': 'application/merge-patch+json' };
        return this.__auth.getAuthToken()
            .then((token) => {
                const headers = Object.assign({}, this.getHeaders(token), patchHeaders);

                return this.__resolver.resolve(path)
                    .then(({ mount, version }) => {
                        let apiPath;
                        if (version === 2) {
                            const logicalPath = this.__logicalPath(path, mount);
                            apiPath = rewritePath(version, 'update', mount, logicalPath);
                        } else {
                            // v1: preserve the caller's literal path byte-for-byte
                            apiPath = path;
                        }

                        // Always wrap in { data } for PATCH (update() is a KV v2 merge-patch operation;
                        // v1 mounts do not support PATCH and Vault will return 405)
                        const requestData = { data };

                        return this.__api.makeRequest('PATCH', apiPath, requestData, headers);
                    });
            })
            .catch((reason) => {
                this.__log.error('update secret failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * Raw request — literal path, no path rewriting or response unwrapping.
     * Returns the parsed body directly.
     *
     * @param {string} method - HTTP method
     * @param {string} path   - literal API path
     * @param {object} [data] - request body
     * @returns {Promise<Object>}
     */
    request(method, path, data) {
        this.__log.debug('raw request %s %s', method, path);
        return this.__auth.getAuthToken()
            .then((token) => this.__api.makeRequest(method, path, data === undefined ? null : data, this.getHeaders(token)))
            .catch((reason) => {
                this.__log.error('raw request failed: %s', reason.message);
                throw reason;
            });
    }

    // -------------------------------------------------------------------------
    // KV v2-only helpers
    // -------------------------------------------------------------------------

    /**
     * Soft-delete specific versions of a KV v2 secret.
     * Throws UnsupportedOperationError on non-v2 mounts.
     *
     * @param {string} path
     * @param {number[]} versions
     * @returns {Promise<Object>}
     */
    deleteVersions(path, versions) {
        this.__log.debug('deleteVersions %s %j', path, versions);
        return this.__v2Only('deleteVersions', 'POST', path, { versions })
            .catch((reason) => {
                this.__log.error('deleteVersions failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * Undelete (restore) specific versions of a KV v2 secret.
     * Throws UnsupportedOperationError on non-v2 mounts.
     *
     * @param {string} path
     * @param {number[]} versions
     * @returns {Promise<Object>}
     */
    undeleteVersions(path, versions) {
        this.__log.debug('undeleteVersions %s %j', path, versions);
        return this.__v2Only('undeleteVersions', 'POST', path, { versions })
            .catch((reason) => {
                this.__log.error('undeleteVersions failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * Permanently destroy specific versions of a KV v2 secret.
     * Throws UnsupportedOperationError on non-v2 mounts.
     *
     * @param {string} path
     * @param {number[]} versions
     * @returns {Promise<Object>}
     */
    destroyVersions(path, versions) {
        this.__log.debug('destroyVersions %s %j', path, versions);
        return this.__v2Only('destroyVersions', 'POST', path, { versions })
            .catch((reason) => {
                this.__log.error('destroyVersions failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * Read KV v2 metadata for a secret.
     * Throws UnsupportedOperationError on non-v2 mounts.
     *
     * @param {string} path
     * @returns {Promise<Object>}
     */
    readMetadata(path) {
        this.__log.debug('readMetadata %s', path);
        return this.__v2Only('readMetadata', 'GET', path, null)
            .then((body) => {
                return normalizeResponse(2, 'readMetadata', body);
            })
            .catch((reason) => {
                this.__log.error('readMetadata failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * Delete all metadata and version history for a KV v2 secret (permanent).
     * Throws UnsupportedOperationError on non-v2 mounts.
     *
     * @param {string} path
     * @returns {Promise<Object>}
     */
    deleteMetadata(path) {
        this.__log.debug('deleteMetadata %s', path);
        return this.__v2Only('deleteMetadata', 'DELETE', path, null)
            .catch((reason) => {
                this.__log.error('deleteMetadata failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * Shared implementation for v2-only operations.
     * Resolves the mount, verifies it is v2, rewrites the path, makes the request.
     * @private
     */
    __v2Only(op, method, path, data) {
        return this.__auth.getAuthToken()
            .then((token) => {
                const headers = this.getHeaders(token);

                return this.__resolver.resolve(path)
                    .then(({ mount, version }) => {
                        if (version !== 2) {
                            throw new errors.UnsupportedOperationError(
                                `Operation "${op}" is only supported on KV v2 mounts. ` +
                                `Mount "${mount}" is not a KV v2 engine.`
                            );
                        }
                        const logicalPath = this.__logicalPath(path, mount);
                        const apiPath = rewritePath(version, op, mount, logicalPath);
                        return this.__api.makeRequest(method, apiPath, data, headers);
                    });
            });
    }

    /**
     * @private
     */
    __setupLogger(logger) {
        if (logger === false) {
            return {
                error: noop,
                warn: noop,
                info: noop,
                debug: noop,
                trace: noop,
            }
        } else if (['error', 'warn', 'info', 'debug', 'trace'].every((method) => typeof logger?.[method] === 'function')) {
            return logger
        } else {
            return {
                error: console.error,
                warn: console.warn,
                info: console.info,
                trace: console.trace,
                // avoid output sensitive information
                debug: noop
            };
        }
    }
}

module.exports = VaultClient;
