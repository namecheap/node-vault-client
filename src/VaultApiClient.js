'use strict';

const urljoin = require('url-join');
const _ = require('lodash');

class VaultApiClient {

    /**
     * @param {Object} config
     * @param {String} config.url - the url of the vault server
     * @param {String} [config.apiVersion='v1']
     * @param {Object} logger
     */
    constructor(config, logger) {
        this.__config = _.defaultsDeep(_.cloneDeep(config), {
            apiVersion: 'v1',
        });

        this._logger = logger;
    }

    makeRequest(method, path, data, headers) {
        data = data === undefined ? null : data;
        headers = headers === undefined ? {} : headers;

        const uri = urljoin(this.__config.url, this.__config.apiVersion, path);

        const options = {
            method: method,
            headers: Object.assign({}, headers),
            redirect: 'follow',
        };
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
