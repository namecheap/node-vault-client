'use strict';

const lt = require('long-timeout');
const prettyMs = require('pretty-ms');
const AuthToken = require('./AuthToken');
const errors = require('../errors');

class VaultBaseAuth {

    /**
     * @param {VaultApiClient} apiClient
     * @param {Object} logger
     * @param {String} mount - Vault's mount point
     */
    constructor(apiClient, logger, mount) {
        this.__apiClient = apiClient;
        /** @protected */
        this._log = logger;
        this._mount = mount;

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
        this._log.info('getting auth token (mount=%s)', this._mount);
        if (this.__authToken === null || (this.__authToken instanceof AuthToken && this.__authToken.isExpired() && this._reauthenticationAllowed())) {
            if (this.__authToken !== null && this.__authToken.isExpired() && !this._reauthenticationAllowed()) {
                throw new errors.AuthTokenExpiredError('Auth token has expired & cannot be refreshed since auth method doesn\'t support this.');
            }

            const tokenPromise = this._authenticate().then(authToken => {
                this.__authToken = authToken;

                if (this.__authToken.isRenewable()) {
                    this._log.debug(
                        'setting refresh timer for token %s',
                        authToken.getId()
                    );
                    this.__setupTokenRefreshTimer(this.__authToken);
                }

                return this.__authToken;
            }).catch(e => {
                this.__authToken = null;
                throw e;
            });

            this.__authToken = tokenPromise;
            return tokenPromise;
        }

        this._log.debug('token already exist');
        return Promise.resolve(this.__authToken);
    }

    /**
     * @protected
     * @returns {Promise<AuthToken>}
     */
    _getTokenEntity(tokenId) {
        return this.__apiClient.makeRequest('GET', '/auth/token/lookup-self', null, {'X-Vault-Token': tokenId})
            .then(res => {
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

    /**
     * @param {AuthToken} authToken
     * @private
     */
    __setupTokenRefreshTimer(authToken) {
        if (this.__refreshTimeout !== null) {
            lt.clearTimeout(this.__refreshTimeout);
            this.__refreshTimeout = null;
        }

        if (!authToken.isRenewable() || authToken.isExpired()) {
            return;
        }

        const timer = Math.max((authToken.getExpiresAt() - Math.floor(Date.now() / 1000)) / 2, 1) * 1000;

        this.__refreshTimeout = lt.setTimeout(() => {
            this.__renewToken(authToken).then(authToken => {
                this.__authToken = authToken;
                this.__setupTokenRefreshTimer(authToken);
            }).catch(err => {
                this.__setupTokenRefreshTimer(authToken);

                this._log.error(`Cannot refresh auth token with "${authToken.getAccessor()}" accessor. Error: ${err.message}`);
                this._log.error(err);
            });
        }, timer);

        this._log.debug(
            'sleeping for %s',
            prettyMs(timer)
        );
    }

    /**
     * @param {AuthToken} authToken
     * @returns {Promise.<AuthToken>}
     * @private
     */
    __renewToken(authToken) {
        this._log.debug('renewing vault token');

        return this.__apiClient.makeRequest('POST', '/auth/token/renew-self', null, {'X-Vault-Token': authToken.getId()})
            .then(() => {
                this._log.info('successfully renewed token');
                return this._getTokenEntity(authToken.getId());
            })
            .catch((reason) => {
                this._log.error('token renew failed: %s', reason.message);
                throw reason;
            });
    }
}

module.exports = VaultBaseAuth;
