'use strict';

const { defaultMaxListeners, getMaxListeners, setMaxListeners } = require('events');
const errors = require('./errors');
const { trimTrailingSlashes } = require('./slashes');

// Above Vault's own default max_request_duration (90 s), so no request a default-configured
// Vault would still answer is cut short, and below the 300 s headers/body timeouts of the
// dispatcher Node's fetch() uses by default.
const DEFAULT_TIMEOUT_MS = 120000;
// setTimeout() fires after 1 ms for a delay that does not fit in a signed 32-bit integer.
const MAX_TIMEOUT_MS = 2147483647;
// The listener limit fetch() gives a signal it is passed (see deadline()).
const FETCH_MAX_LISTENERS = 1500;
// The statuses fetch() follows, its limit on hops, and the headers it drops when a redirect
// turns the request into a GET without a body (Fetch Standard, "HTTP-redirect fetch").
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const BODY_HEADERS = new Set(['content-encoding', 'content-language', 'content-location', 'content-type']);

function validateTimeout(timeout) {
    // null reads as "not set", as it does in a config file.
    if (timeout === undefined || timeout === null) {
        return DEFAULT_TIMEOUT_MS;
    }
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > MAX_TIMEOUT_MS) {
        throw new errors.InvalidArgumentsError(
            `"api.timeout" should be an integer number of milliseconds from 0 to ${MAX_TIMEOUT_MS}, ` +
            `got ${String(timeout)}`
        );
    }
    return timeout;
}

/**
 * What fetch() accepts as a signal: Node 20 and 22 take any object with a boolean `aborted`
 * and an `addEventListener` (an abort-controller polyfill, a signal from another realm).
 */
function isSignalLike(value) {
    return value !== null && typeof value === 'object'
        && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function';
}

/**
 * A per-request deadline. A plain timer, cleared once the request settles, rather than
 * AbortSignal.timeout(), whose timer cannot be cancelled and so outlives every fast request.
 * A `requestOptions.signal` still aborts the request: it is followed through a listener that
 * is removed at the same point, since that signal lives as long as the client.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal] - `requestOptions.signal`
 * @returns {{signal: AbortSignal, isTimeout: function(*): boolean, clear: function(): void}}
 */
function deadline(ms, signal) {
    const controller = new AbortController();
    const reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const timer = setTimeout(() => controller.abort(reason), ms);
    const follow = () => controller.abort(signal.reason);
    if (signal) {
        if (signal.aborted) {
            follow();
        } else {
            // fetch() raised a signal's listener limit to 1500 when it was still at the default;
            // it now gets the client's own signal, so do the same here, or more than ten
            // requests in flight on one signal print MaxListenersExceededWarning (Node 20).
            try {
                if (getMaxListeners(signal) === defaultMaxListeners) {
                    setMaxListeners(FETCH_MAX_LISTENERS, signal);
                }
            } catch {
                // not an EventTarget (a polyfill): it has no listener limit to raise
            }
            signal.addEventListener('abort', follow, { once: true });
        }
    }

    return {
        signal: controller.signal,
        isTimeout: (err) => err === reason,
        clear: () => {
            clearTimeout(timer);
            if (signal && typeof signal.removeEventListener === 'function') {
                signal.removeEventListener('abort', follow);
            }
        },
    };
}

function isPrintableAscii(value) {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code > 0x7e) {
            return false;
        }
    }
    return true;
}

/**
 * Follows the redirects of a request sent with `redirect: 'manual'` as fetch()'s 'follow'
 * would, but only within the origin of the URL it was sent to. 'follow' sends every header
 * but Authorization, Cookie and Proxy-Authorization to any origin a Location names, so
 * X-Vault-Token, and on a 307/308 a login body, would reach that origin, and its answer would
 * be read as Vault's.
 *
 * @param {Response} response - the answer to the request
 * @param {string} url - the URL the request was sent to
 * @param {Object} options - the fetch() options it was sent with
 * @param {number} [hops=0] - redirects followed so far
 * @returns {Response|Promise<Response>} the first answer that is not a redirect
 */
function followSameOrigin(response, url, options, hops = 0) {
    let location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
    if (location === null) {
        return response;
    }
    // A redirect's own body is never read.
    if (response.body) {
        response.body.cancel().catch(() => {});
    }

    // Where fetch() gives up on a redirect, it rejects with this; so does this, except for the
    // one thing it adds: refusing another origin.
    const fetchFailed = (cause) => new TypeError('fetch failed', { cause });
    // As fetch() does: a Location sent as raw UTF-8 bytes instead of percent-encoded.
    if (!isPrintableAscii(location)) {
        location = Buffer.from(location, 'latin1').toString('utf8');
    }
    let next;
    try {
        next = new URL(location, url);
    } catch (err) {
        throw fetchFailed(err);
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw fetchFailed(new TypeError('URL scheme must be a HTTP(S) scheme'));
    }
    if (hops === MAX_REDIRECTS) {
        throw fetchFailed(new TypeError('redirect count exceeded'));
    }
    const from = new URL(url);
    if (next.origin !== from.origin) {
        throw new errors.VaultError(
            `Refusing to follow a redirect from ${from.origin} to ${next.origin}: ` +
            'only redirects within the origin of "api.url" are followed'
        );
    }
    if (next.username !== '' || next.password !== '') {
        throw fetchFailed(new TypeError('redirect location includes credentials'));
    }

    let nextOptions = options;
    const method = options.method.toUpperCase();
    if ((response.status === 303 && method !== 'GET' && method !== 'HEAD')
        || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        const headers = {};
        for (const [name, value] of Object.entries(options.headers)) {
            if (!BODY_HEADERS.has(name.toLowerCase())) {
                headers[name] = value;
            }
        }
        nextOptions = Object.assign({}, options, { method: 'GET', headers });
        delete nextOptions.body;
    }

    return fetch(next.href, nextOptions)
        .then((nextResponse) => followSameOrigin(nextResponse, next.href, nextOptions, hops + 1));
}

/**
 * Joins URL segments with single slashes while preserving the leading
 * protocol (e.g. "https://"). Replaces the former `url-join` dependency.
 */
function joinUrl(...parts) {
    return parts
        .map((part, i) => {
            let segment = String(part);
            if (i > 0) {
                segment = segment.replace(/^\/+/, '');
            }
            if (i < parts.length - 1) {
                segment = trimTrailingSlashes(segment);
            }
            return segment;
        })
        .filter((segment) => segment.length > 0)
        .join('/');
}

/**
 * Host:port pairs already warned about for plain http://, so one process logs the warning once
 * per Vault host and port however many clients it creates. It holds one short string per
 * distinct configured Vault address.
 * @type {Set<string>}
 */
const warnedPlainHttpHosts = new Set();

/** `::ffff:127.x.y.z` as WHATWG URL prints it: `[::ffff:7fXX:XXXX]`. */
const IPV4_MAPPED_LOOPBACK = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True for a host that never leaves the machine: `localhost` and its subdomains, 127.0.0.0/8,
 * its IPv4-mapped IPv6 form `::ffff:127.0.0.0/104`, `::1`, and the unspecified addresses
 * `0.0.0.0` and `::`, which connect to this machine. `hostname` is WHATWG-normalised, so IPv4
 * shorthands such as `127.1` already read `127.0.0.1` and IPv6 is bracketed and compressed.
 * @param {string} hostname - `URL#hostname`
 * @returns {boolean}
 * @private
 */
function isLoopbackHost(hostname) {
    const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    return host === 'localhost'
        || host.endsWith('.localhost')
        || host === '[::1]'
        || host === '[::]'
        || host === '0.0.0.0'
        || IPV4_MAPPED_LOOPBACK.test(host)
        || IPV4_LOOPBACK.test(host);
}

/**
 * Warn, once per host:port and process, when `api.url` is plain http:// to a host off this
 * machine: the token and every secret would cross the network unencrypted. Only the host and
 * port are named, never credentials or a path from the URL. An unparsable URL is left to fail
 * where it is used, as before, and a throwing logger does not fail the request. Called on a
 * client's first request rather than in the constructor, so a VaultClient whose construction
 * fails after building this client uses up no warning.
 * @param {*} url - `api.url`
 * @param {Object} logger
 * @returns {void}
 * @private
 */
function warnOnPlainHttp(url, logger) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return;
    }
    if (parsed.protocol !== 'http:' || isLoopbackHost(parsed.hostname) || warnedPlainHttpHosts.has(parsed.host)) {
        return;
    }
    try {
        logger.warn(
            '"api.url" uses plain http:// for %s, which is not a loopback address; the Vault token and '
            + 'secrets travel unencrypted. Use https:// unless the network path is protected otherwise',
            parsed.host
        );
        // Only once it has been logged, so a throwing logger does not use it up.
        warnedPlainHttpHosts.add(parsed.host);
    } catch {
        // a throwing logger must not fail the request
    }
}

class VaultApiClient {

    /**
     * @param {Object} config
     * @param {String} config.url - the url of the vault server
     * @param {String} [config.apiVersion='v1']
     * @param {Object} [config.requestOptions] - extra options shallow-merged into every
     *      `fetch()` call. Use it to inject an undici `dispatcher` for a proxy/SOCKS agent
     *      or for custom TLS trust (self-signed / internal CA). Request-specific fields
     *      (`method`, `body`) always take precedence; `headers` are merged with the
     *      per-request headers winning. Stored by reference (not deep-cloned) so live
     *      objects such as a Dispatcher keep their prototype and remain usable. Without a
     *      `redirect` there, redirects are followed only within the origin of `config.url`;
     *      a `redirect` there other than `null` is passed to `fetch()` as it is (`'follow'`
     *      follows them to any origin).
     * @param {number} [config.timeout=120000] - milliseconds a request may take, response
     *      headers, body and redirects included, before it rejects with
     *      {@link RequestTimeoutError}. `0` turns the limit off; `null` gives the default.
     * @param {Object} logger
     * @param {String} [namespace] - Vault namespace. When set, `X-Vault-Namespace` is added to
     *      every request (login, token lookup/renewal, and secret operations) so namespacing is
     *      owned in one place instead of being reapplied per auth backend. An explicit
     *      `X-Vault-Namespace` passed to {@link VaultApiClient#makeRequest} overrides it.
     */
    constructor(config, logger, namespace) {
        const requestOptions = config && config.requestOptions;

        const baseConfig = { ...(config || {}) };
        delete baseConfig.requestOptions;
        this.__config = structuredClone(baseConfig);
        if (this.__config.apiVersion === undefined) {
            this.__config.apiVersion = 'v1';
        }

        if (requestOptions !== undefined) {
            this.__config.requestOptions = requestOptions;
        }

        this.__timeout = validateTimeout(this.__config.timeout);
        // 3.0.x ignored an api.timeout key, so a config may still carry one written in seconds.
        if (this.__timeout > 0 && this.__timeout < 1000) {
            logger.warn('"api.timeout" is %d ms; it is in milliseconds, not seconds', this.__timeout);
        }

        this.__plainHttpChecked = false;

        this.__namespace = namespace !== undefined ? namespace : this.__config.namespace;
        this._logger = logger;
    }

    makeRequest(method, path, data, headers) {
        if (!this.__plainHttpChecked) {
            this.__plainHttpChecked = true;
            warnOnPlainHttp(this.__config.url, this._logger);
        }
        data = data === undefined ? null : data;
        headers = headers === undefined ? {} : headers;

        const uri = joinUrl(this.__config.url, this.__config.apiVersion, path);

        const requestOptions = this.__config.requestOptions || {};

        // Inject the namespace as a low-priority default so every request (login, token
        // lookup/renewal, secret ops) is namespaced from a single place, while an explicit
        // per-request or requestOptions X-Vault-Namespace still wins.
        const namespaceHeader = this.__namespace ? { 'X-Vault-Namespace': this.__namespace } : {};

        const options = Object.assign(
            {},
            requestOptions,
            {
                method: method,
                headers: Object.assign(
                    { Accept: 'application/json' },
                    namespaceHeader,
                    requestOptions.headers,
                    headers
                ),
            }
        );
        // Read after the merge, which copies only own enumerable keys: a `redirect` it leaves
        // out, or an explicit `redirect: undefined`, must not turn fetch()'s 'follow' back on.
        // null reads as "not set", as it does for api.timeout (fetch() rejected it).
        const sameOrigin = options.redirect === undefined || options.redirect === null;
        if (sameOrigin) {
            options.redirect = 'manual';
        }
        if (data !== null) {
            options.body = JSON.stringify(data);
            // Only set the default content-type if the caller did not already supply one.
            // Case-insensitive check to honour merge-patch+json and other overrides.
            const hasContentType = Object.keys(options.headers)
                .some((k) => k.toLowerCase() === 'content-type');
            if (!hasContentType) {
                options.headers['Content-Type'] = 'application/json';
            }
        }

        this._logger.debug(
            'making request: %s %s',
            method,
            uri
        );

        // A requestOptions.signal that fetch() would reject is passed on untouched, without the
        // deadline, so fetch() rejects it as it always has. The deadline is armed last, and
        // cleared if fetch() throws synchronously, so no timer outlives a failed call.
        const userSignal = requestOptions.signal;
        const limit = this.__timeout > 0 && (userSignal === undefined || userSignal === null
            || isSignalLike(userSignal))
            ? deadline(this.__timeout, userSignal || undefined)
            : null;
        let pending;
        if (limit === null) {
            pending = fetch(uri, options);
        } else {
            options.signal = limit.signal;
            try {
                pending = fetch(uri, options);
            } catch (err) {
                limit.clear();
                throw err;
            }
        }

        if (sameOrigin) {
            pending = pending.then((response) => followSameOrigin(response, uri, options));
        }

        const request = pending.then((response) => {
            return response.text().then((text) => {
                let body;
                if (text) {
                    try {
                        body = JSON.parse(text);
                    } catch {
                        body = text;
                    }
                }

                if (!response.ok) {
                    throw new errors.VaultHttpError(response.status, text, body);
                }

                // Do not log the response body: Vault responses carry secret
                // material (auth tokens, secret reads). Log status only.
                this._logger.debug('%s %s -> %d',
                    method,
                    uri,
                    response.status
                );
                return body;
            });
        });
        if (limit === null) {
            return request;
        }

        return request
            .catch((err) => {
                if (limit.isTimeout(err)) {
                    throw new errors.RequestTimeoutError(this.__timeout, { cause: err });
                }
                throw err;
            })
            .finally(limit.clear);
    }
}

module.exports = VaultApiClient;
