'use strict';

const rp = require('request-promise');
const urljoin = require('url-join');
const _ = require('lodash');

class VaultApiClient {

    /**
     * @param {Object} config
     * @param {String} config.url - the url of the vault server
     * @param {String} [config.apiVersion='v1']
     * @param {Object} options
     * @param {Object} options.logger
     */
    constructor(config, options) {
        this.__config = _.defaultsDeep(_.cloneDeep(config), {
            apiVersion: 'v1',
        });

        this.logger = options.logger;
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
        };

        this.logger.debug(
            'making request: %s %s',
            requestOptions.method,
            requestOptions.uri
        );

        return rp(requestOptions);
    }
}

module.exports = VaultApiClient;
