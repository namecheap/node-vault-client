'use strict';

const lt = require('long-timeout');

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
        this.__refreshTimeout = null;
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

                this.__setupTokenRefreshTimer(this.__authToken);

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

    __setupTokenRefreshTimer(authToken) {
        if (this.__refreshTimeout !== null) {
            lt.clearTimeout(this.__refreshTimeout);
            this.__refreshTimeout = null;
        }

        if (authToken.isRenewable()) {
            return;
        }

        this.__refreshTimeout = lt.setTimeout(() => {
            this.__apiClient.makeRequest('GET', '/auth/token/renew-self', null, {'X-Vault-Token': authToken.getId()}).then(() => {
                return this._getTokenEntity(authToken.getId());
            }).then(authToken => {
                this.__authToken = authToken;
                this.__setupTokenRefreshTimer(authToken);
            }).catch(err => {
                //TODO: error logging should be added
            });
        }, ( authToken.getExpiresAt() - Math.floor(Date.now() / 1000) ) * 1000);
    }

}

module.exports = VaultBaseAuth;
