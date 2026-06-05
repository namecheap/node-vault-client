'use strict';

const urljoin = require('url-join');
const _ = require('lodash');

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

        this.__config = _.defaultsDeep(_.cloneDeep(_.omit(config, ['requestOptions'])), {
            apiVersion: 'v1',
        });

        if (requestOptions !== undefined) {
            this.__config.requestOptions = requestOptions;
        }

        this._logger = logger;
    }

    makeRequest(method, path, data, headers) {
        data = data === undefined ? null : data;
        headers = headers === undefined ? {} : headers;

        const uri = urljoin(this.__config.url, this.__config.apiVersion, path);

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
            options.headers['Content-Type'] = 'application/json';
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
                    } catch (e) {
                        body = text;
                    }
                }

                if (!response.ok) {
                    const error = new Error(`${response.status} - ${text}`);
                    error.statusCode = response.status;
                    error.error = body;
                    throw error;
                }

                this._logger.debug('%s %s response body:\n%s',
                    method,
                    uri,
                    JSON.stringify(body, null, ' ')
                );
                return body;
            });
        });
    }
}

module.exports = VaultApiClient;
