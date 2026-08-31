'use strict';

// `long-timeout` is unmaintained (last release 2016) but tiny (~50 LOC), dependency-free and
// stable: it only works around setTimeout's 32-bit signed-int limit (~24.8 days), which real
// Vault token TTLs can exceed. Audited and deliberately kept as-is (see issue #111); revisit
// only if a maintained alternative or a Node.js core fix appears.
const lt = require('long-timeout');
const AuthToken = require('./AuthToken');
const errors = require('../errors');

/**
 * Formats a millisecond duration as a short human-readable string
 * (e.g. "1s", "2m 5s", "1h 3m"). Replaces the former `pretty-ms` dependency.
 */
function humanizeMs(ms) {
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) {
        return `${totalMinutes}m ${totalSeconds % 60}s`;
    }
    const hours = Math.floor(totalMinutes / 60);
    return `${hours}h ${totalMinutes % 60}m`;
}

class VaultBaseAuth {

    /**
     * @param {VaultApiClient} apiClient
     * @param {Object} logger
     * @param {String} mount - Vault's mount point
     * @param {Object} [config] - the auth backend's `auth.config`. Only
     *   `config.renewal` is read here; everything else belongs to the subclass.
     * @param {boolean} [config.renewal=true] - Set `false` to never renew the Vault token
     *   in the background. The client then keeps using the token until it expires and
     *   re-authenticates on the next call (auth methods that cannot re-authenticate, such
     *   as `token`, raise {@link AuthTokenExpiredError} instead, exactly as they do today).
     */
    constructor(apiClient, logger, mount, config) {
        this.__apiClient = apiClient;
        /** @protected */
        this._log = logger;
        this._mount = mount;
        this.__renewalEnabled = !(config && config.renewal === false);

        /**
         * The currently held token, or `null` when none has been obtained yet.
         * @type {AuthToken|null}
         */
        this.__authToken = null;
        /**
         * The in-flight login, or `null` when no login is running. Concurrent
         * `getAuthToken()` callers await this same promise (single-flight).
         * @type {Promise<AuthToken>|null}
         */
        this.__pendingLogin = null;
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
        if (this.__pendingLogin !== null) {
            this._log.debug('login already in flight');
            return this.__pendingLogin;
        }

        const tokenExpired = this.__authToken !== null && this.__authToken.isExpired();

        if (tokenExpired && !this._reauthenticationAllowed()) {
            return Promise.reject(new errors.AuthTokenExpiredError(
                'Auth token has expired & cannot be refreshed since auth method doesn\'t support this.'
            ));
        }

        if (this.__authToken !== null && !tokenExpired) {
            this._log.debug('token already exist');
            return Promise.resolve(this.__authToken);
        }

        this._log.info('getting auth token (mount=%s)', this._mount);

        const pendingLogin = this._authenticate().then(authToken => {
            this.__pendingLogin = null;
            this.__authToken = authToken;

            if (authToken.isRenewable()) {
                this._log.debug(
                    'setting refresh timer for token (accessor=%s)',
                    authToken.getAccessor()
                );
                this.__setupTokenRefreshTimer(authToken);
            }

            return authToken;
        }).catch(e => {
            this.__pendingLogin = null;
            this.__authToken = null;
            throw e;
        });

        this.__pendingLogin = pendingLogin;
        return pendingLogin;
    }

    /**
     * Cancel any pending token-refresh timer.
     *
     * When a renewable token is fetched the client arms a `long-timeout` timer to renew it
     * before it expires. That timer keeps the Node.js event loop alive, so a short-lived
     * script never exits on its own. Call this (or {@link VaultClient#close}) once you are
     * done with the client to release the event loop. Safe to call when no timer is armed
     * and safe to call multiple times.
     *
     * @returns {void}
     */
    cancelTokenRefresh() {
        if (this.__refreshTimeout !== null) {
            lt.clearTimeout(this.__refreshTimeout);
            this.__refreshTimeout = null;
        }
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

        if (!this.__renewalEnabled || !authToken.isRenewable() || authToken.isExpired()) {
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
            humanizeMs(timer)
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
