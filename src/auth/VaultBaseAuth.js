'use strict';

const lt = require('long-timeout');
const prettyMs = require('pretty-ms');
const AuthToken = require('./AuthToken');
const errors = require('../errors');
const safeMessage = require('../safeMessage');

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
        if (this.__authToken === null || (this.__authToken instanceof AuthToken && this.__authToken.isExpired() && this._reauthenticationAllowed())) {
            if (this.__authToken !== null && this.__authToken.isExpired() && !this._reauthenticationAllowed()) {
                throw new errors.AuthTokenExpiredError('Auth token has expired & cannot be refreshed since auth method doesn\'t support this.');
            }

            this._log.info('getting auth token (mount=%s)', this._mount);

            const tokenPromise = this._authenticate().then(authToken => {
                this.__authToken = authToken;

                if (this.__authToken.isRenewable()) {
                    this._log.debug(
                        'setting refresh timer for token (accessor=%s)',
                        authToken.getAccessor()
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

                // Only the safe message: the error object itself used to be logged too, and a
                // request-promise error carries the request options (the X-Vault-Token header)
                // and a non-2xx response body (GHSA-2vr8-g4vw-7xpm).
                this._log.error(`Cannot refresh auth token with "${authToken.getAccessor()}" accessor. Error: ${safeMessage(err)}`);
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
                this._log.error('token renew failed: %s', safeMessage(reason));
                throw reason;
            });
    }
}

module.exports = VaultBaseAuth;
