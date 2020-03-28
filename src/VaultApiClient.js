'use strict';

const rp = require('request-promise');
const urljoin = require('url-join');
const _ = require('lodash');

class VaultApiClient {

    /**
     * @param {Object} config
     * @param {String} config.url - the url of the vault server
     * @param {String} [config.apiVersion='v1']
     * @param {Object} logger
     */
    constructor(config, logger, requestOptions) {
        this.__config = _.defaultsDeep(_.cloneDeep(config), {
            apiVersion: 'v1',
        });

        this._logger = logger;

        this.__requestOptions = requestOptions;
    }

    makeRequest(method, path, data, headers) {
        data = data === undefined ? null : data;
        headers = headers === undefined ? {} : headers;

        const requestOptions = {
            method: method,
            body: data === null ? undefined : data,
            uri: urljoin(this.__config.url, this.__config.apiVersion, path),
            followRedirects: true,
            followAllRedirects: true,
            headers,
            json: true,
            ...this.__requestOptions
        };

        this._logger.debug(
            'making request: %s %s',
            requestOptions.method,
            requestOptions.uri
        );

        return rp(requestOptions)
            .then((response) => {
                this._logger.debug('%s %s response body:\n%s',
                    requestOptions.method,
                    requestOptions.uri,
                    JSON.stringify(response, null, ' ')
                );
                return response;
            });
    }
}

module.exports = VaultApiClient;
