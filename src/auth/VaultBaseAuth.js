'use strict';

// `long-timeout` is unmaintained (last release 2016) but tiny (~50 LOC), dependency-free and
// stable: it only works around setTimeout's 32-bit signed-int limit (~24.8 days), which real
// Vault token TTLs can exceed. Audited and deliberately kept as-is (see issue #111); revisit
// only if a maintained alternative or a Node.js core fix appears.
const lt = require('long-timeout');
const AuthToken = require('./AuthToken');

/** Renew at the halfway point of the token's remaining lifetime. */
const DEFAULT_RENEWAL_FRACTION = 0.5;
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
     * @param {number} [config.renewalFraction=0.5] - How much of the token's remaining
     *   lifetime to wait before renewing, as a fraction in `(0, 1]`. The default renews at
     *   the halfway point. Lower renews earlier and more often (more headroom if Vault is
     *   briefly unreachable); higher renews later.
     * @param {number} [config.renewalIncrement] - Seconds of additional TTL to request on
     *   each renewal, sent as `increment` to `auth/token/renew-self`. Omitted by default,
     *   which lets Vault apply the token's own period. Vault may grant less, capped by the
     *   token's max TTL.
     */
    constructor(apiClient, logger, mount, config) {
        this.__apiClient = apiClient;
        /** @protected */
        this._log = logger;
        this._mount = mount;
        this.__renewalEnabled = VaultBaseAuth.__validateRenewal(config);
        this.__renewalFraction = VaultBaseAuth.__validateFraction(config);
        this.__renewalIncrement = VaultBaseAuth.__validateIncrement(config);

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
     * Strict on purpose: node-config's `custom-environment-variables` yields strings, so a
     * loose check would read `VAULT_RENEWAL=false` as `'false'` and leave renewal on -- the
     * exact hang the flag exists to prevent, silently.
     *
     * @param {Object} [config]
     * @returns {boolean}
     * @private
     */
    static __validateRenewal(config) {
        if (!config || config.renewal === undefined) {
            return true;
        }

        if (typeof config.renewal !== 'boolean') {
            throw new errors.InvalidArgumentsError(
                `"renewal" should be a boolean, got ${String(config.renewal)}`
            );
        }

        return config.renewal;
    }

    /**
     * @param {Object} [config]
     * @returns {number}
     * @private
     */
    static __validateFraction(config) {
        if (!config || config.renewalFraction === undefined) {
            return DEFAULT_RENEWAL_FRACTION;
        }

        const fraction = config.renewalFraction;
        // Exclusive upper bound: at exactly 1 the timer fires at the same instant
        // getAuthToken() starts treating the token as expired, racing the client's own
        // re-authentication and leaving no headroom for the renewal request itself.
        if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
            throw new errors.InvalidArgumentsError(
                `"renewalFraction" should be a number in (0, 1), got ${String(fraction)}`
            );
        }

        return fraction;
    }

    /**
     * @param {Object} [config]
     * @returns {number|undefined}
     * @private
     */
    static __validateIncrement(config) {
        if (!config || config.renewalIncrement === undefined) {
            return undefined;
        }

        const increment = config.renewalIncrement;
        if (!Number.isInteger(increment) || increment <= 0) {
            throw new errors.InvalidArgumentsError(
                `"renewalIncrement" should be a positive integer number of seconds, got ${String(increment)}`
            );
        }

        return increment;
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
                // Gate the log on the flag too: the guard lives inside
                // __setupTokenRefreshTimer, so without this the client claims it armed a
                // timer while arming nothing -- the one diagnostic an operator reads when a
                // `renewal: false` process still hangs.
                if (this.__renewalEnabled) {
                    this._log.debug(
                        'setting refresh timer for token (accessor=%s)',
                        authToken.getAccessor()
                    );
                } else {
                    this._log.debug(
                        'renewal disabled by config; not arming a refresh timer (accessor=%s)',
                        authToken.getAccessor()
                    );
                }
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

        const remaining = authToken.getExpiresAt() - Math.floor(Date.now() / 1000);
        const timer = Math.max(remaining * this.__renewalFraction, 1) * 1000;

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

        // null, not {}, when unset: that is the body the client has always sent.
        const data = this.__renewalIncrement === undefined ? null : {increment: this.__renewalIncrement};

        return this.__apiClient.makeRequest('POST', '/auth/token/renew-self', data, {'X-Vault-Token': authToken.getId()})
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
