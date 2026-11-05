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
     *      objects such as a Dispatcher keep their prototype and remain usable.
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

        this.__namespace = namespace !== undefined ? namespace : this.__config.namespace;
        this._logger = logger;
    }

    makeRequest(method, path, data, headers) {
        data = data === undefined ? null : data;
        headers = headers === undefined ? {} : headers;

        const uri = joinUrl(this.__config.url, this.__config.apiVersion, path);

        const requestOptions = this.__config.requestOptions || {};

        // Inject the namespace as a low-priority default so every request (login, token
        // lookup/renewal, secret ops) is namespaced from a single place, while an explicit
        // per-request or requestOptions X-Vault-Namespace still wins.
        const namespaceHeader = this.__namespace ? { 'X-Vault-Namespace': this.__namespace } : {};

        const options = Object.assign(
            { redirect: 'follow' },
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
