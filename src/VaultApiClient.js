'use strict';

const rp = require('request-promise');
const urljoin = require('url-join');
const _ = require('lodash');

/**
 * request-promise errors keep the request `options` (the `X-Vault-Token` header and the request
 * body: written secrets, AppRole credentials, the Kubernetes JWT) and the `response`, whose
 * request carries the same headers. Printing such an error (console.error(err), an error tracker,
 * JSON.stringify) printed the token. Keep both properties readable, but non-enumerable, so they
 * no longer show up when the error is inspected or serialised.
 *
 * @param {*} err
 * @returns {*} the same error
 */
function hideRequestDetails(err) {
    if (err && typeof err === 'object') {
        ['options', 'response'].forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(err, key)) {
                Object.defineProperty(err, key, { enumerable: false });
            }
        });
    }
    return err;
}

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
            body: data === null ? undefined : data,
            uri: urljoin(this.__config.url, this.__config.apiVersion, path),
            followRedirects: true,
            followAllRedirects: true,
            headers,
            json: true,
        };

        this._logger.debug(
            'making request: %s %s',
            requestOptions.method,
            requestOptions.uri
        );

        return rp(requestOptions)
            .then((response) => {
                // Do not log the response body: Vault responses carry secret material (auth
                // tokens, secret reads). See issue #204.
                this._logger.debug('%s %s -> response received',
                    requestOptions.method,
                    requestOptions.uri
                );
                return response;
            }, (err) => {
                throw hideRequestDetails(err);
            });
    }
}

module.exports = VaultApiClient;
