'use strict';

const AuthToken = require('./AuthToken');
const errors = require('../errors');

class VaultBaseAuth {

    /**
     * @param {VaultApiClient} apiClient
     */
    constructor(apiClient) {
        this.__apiClient = apiClient;

        /** @type AuthToken */
        this.__authToken = null;
    }

    /**
     * @protected
     * @returns {Promise<AuthToken>}
     */
    _authenticate() {
        throw new Error('Method should be overridden');
    }

    getAuthToken() {
        if (this.__authToken === null || (this.__authToken.isExpired() && this._reauthenticationAllowed())) {
            if (this.__authToken !== null && this.__authToken.isExpired() && !this._reauthenticationAllowed()) {
                throw new errors.AuthTokenExpiredError('Auth token has expired & cannot be refreshed since auth method doesn\'t support this.');
            }

            return this._authenticate().then(authToken => {
                this.__authToken = authToken;

                return this.__authToken;
            });
        }

        return Promise.resolve(this.__authToken);
    }

    /**
     * @protected
     * @returns {Promise<AuthToken>}
     */
    _getTokenEntity(tokenId) {
        return this.__apiClient.makeRequest('GET', '/auth/token/lookup-self', null, {'X-Vault-Token': tokenId}).then(res => {
            return AuthToken.fromResponse(res);
        });
    }

    /**
     * @protected
     * @returns {boolean}
     */
    _reauthenticationAllowed() {
        return true;
    }

}

module.exports = VaultBaseAuth;
