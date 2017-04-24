'use strict';

const rp = require('request-promise');
const urljoin = require('url-join');
const _ = require('lodash');

class VaultApiClient {

    /**
     * @param {Object} config
     * @param {String} config.url - the url of the vault server
     * @param {String} [config.apiVersion='v1']
     */
    constructor(config) {
        this.__config = _.defaultsDeep(config, {
            apiVersion: 'v1',
        });
    }

    makeRequest(method, path, data = null, headers = {}) {
        const requestOptions = {
            method: method,
            body: data === null ? undefined : data,
            uri: urljoin(this.__config.url, this.__config.apiVersion, path),
            followRedirects: true,
            followAllRedirects: true,
            headers,
            json: true,
        };

        return rp(requestOptions);
    }
}

module.exports = VaultApiClient;
