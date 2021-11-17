'use strict';

const axios = require('axios');
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

        const requestOptions = {
            method: method,
            data: data === null ? undefined : data,
            url: urljoin(this.__config.url, this.__config.apiVersion, path),
            headers,
        };

        this._logger.debug(
            'making request: %s %s',
            requestOptions.method,
            requestOptions.url
        );

        return axios.request(requestOptions)
            .then((response) => {
                this._logger.debug('%s %s response body:\n%s',
                    requestOptions.method,
                    requestOptions.url,
                    JSON.stringify(response.data, null, ' ')
                );
                return response.data;
            });
    }
}

module.exports = VaultApiClient;
