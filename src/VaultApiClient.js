'use strict';

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
                segment = segment.replace(/\/+$/, '');
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
     * @param {Object} logger
     */
    constructor(config, logger) {
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

        this._logger = logger;
    }

    makeRequest(method, path, data, headers) {
        data = data === undefined ? null : data;
        headers = headers === undefined ? {} : headers;

        const uri = joinUrl(this.__config.url, this.__config.apiVersion, path);

        const requestOptions = this.__config.requestOptions || {};

        const options = Object.assign(
            { redirect: 'follow' },
            requestOptions,
            {
                method: method,
                headers: Object.assign(
                    { Accept: 'application/json' },
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

        return fetch(uri, options).then((response) => {
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
                    const error = new Error(`${response.status} - ${text}`);
                    error.statusCode = response.status;
                    error.error = body;
                    throw error;
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
    }
}

module.exports = VaultApiClient;
