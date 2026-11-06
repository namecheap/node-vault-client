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
const safeMessage = require('../safeMessage');

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

/**
 * Read precise expiry when available, preserving the public AuthToken interface fallback.
 * @param {AuthToken} authToken
 * @returns {number|null}
 * @private
 */
/**
 * True for a token Vault marked renewable whose lookup gave nothing to schedule a renewal from
 * (see {@link AuthToken.fromResponse}). It is not renewable, but the renewal timer still reports
 * it, as it did while such a lookup resolved to a NaN deadline.
 * @param {AuthToken} authToken
 * @returns {boolean}
 */
function renewableWithoutExpiry(authToken) {
    return authToken.__renewableWithoutExpiry === true;
}

function tokenExpiryMilliseconds(authToken) {
    if (typeof authToken.getExpiresAtMilliseconds === 'function') {
        const expiry = authToken.getExpiresAtMilliseconds();
        if (Number.isFinite(expiry)) {
            return expiry;
        }
    }

    const expiry = authToken.getExpiresAt();
    return typeof expiry === 'number' && Number.isFinite(expiry) ? expiry * 1000 : null;
}

/**
 * True when Vault says it granted less than the requested lifetime because the token reached a
 * maximum TTL (its explicit max TTL, the role's `token_max_ttl` or the mount's max lease TTL).
 * Vault reports this on every capped renew-self as a warning such as
 * `TTL of "10s" exceeded the effective max_ttl of "9s"; TTL value is capped accordingly`
 * (measured on 1.21 and 2.2) and never on an uncapped one. A capped token's deadline cannot move
 * again, so further renewals are pointless; the next one would fail with "past the max TTL".
 *
 * Vault's other cap warning, `period of "4s" exceeded the effective max_ttl of "2s"; period value
 * is capped accordingly`, must NOT match: it is sent on every renewal of a periodic token whose
 * period exceeds the role's `token_max_ttl` or the mount's max lease TTL, and that token stays
 * renewable indefinitely at the shorter period (measured on 2.2).
 *
 * `lease_duration < increment` is not a usable substitute: periodic tokens ignore the increment.
 *
 * @param {Object|null|undefined} renewResponse - renew-self response body
 * @returns {boolean}
 * @private
 */
function renewalCappedByMaxTtl(renewResponse) {
    const warnings = renewResponse && Array.isArray(renewResponse.warnings) ? renewResponse.warnings : [];
    return warnings.some((warning) => typeof warning === 'string'
        && /max_?ttl/i.test(warning) && /\bTTL value is capped\b/i.test(warning));
}

/**
 * ISO form of a millisecond timestamp, or its plain string form when Date cannot represent it,
 * so that a log line about a duck-typed token never throws a RangeError.
 * @param {number} ms
 * @returns {string}
 * @private
 */
function formatTimestamp(ms) {
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString();
}

/**
 * Explain why background renewal ended without exposing the token ID.
 * @param {VaultBaseAuth} auth
 * @param {AuthToken} authToken
 * @param {string} reason
 * @returns {void}
 * @private
 */
function warnRenewalStopped(auth, authToken, reason) {
    const expiry = tokenExpiryMilliseconds(authToken);
    const nextAction = expiry === null
        ? 'expiry is unknown; the cached token remains in use until it is replaced'
        : auth._reauthenticationAllowed()
            ? 'the next call after expiry will re-authenticate'
            : 'the next call after expiry will fail with AuthTokenExpiredError';

    auth._log.warn(
        'token renewal stopped (accessor=%s): %s; client-side expiry is %s; %s',
        authToken.getAccessor(),
        reason,
        expiry === null ? 'unknown' : formatTimestamp(expiry),
        nextAction
    );
}

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
        this.__renewalEnabled = true;
        this.__renewalFraction = DEFAULT_RENEWAL_FRACTION;
        this.__renewalIncrement = undefined;

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
        this.__renewalEpoch = 0;
    }

    /**
     * Apply the renewal options from `auth`. Separate from the constructor so that the
     * subclass signatures -- and this one -- stay exactly as they were: anything already
     * subclassing VaultBaseAuth keeps working untouched.
     *
     * @param {Object} [authConfig] - the `auth` block from VaultClient's options
     * @param {boolean} [authConfig.renewal=true]
     * @param {number} [authConfig.renewalFraction=0.5]
     * @param {number} [authConfig.renewalIncrement]
     * @returns {void}
     */
    configureRenewal(authConfig) {
        this.__renewalEnabled = VaultBaseAuth.__validateRenewal(authConfig);
        this.__renewalFraction = VaultBaseAuth.__validateFraction(authConfig);
        this.__renewalIncrement = VaultBaseAuth.__validateIncrement(authConfig);
    }

    /**
     * Strict on purpose: node-config's `custom-environment-variables` yields strings, so a
     * loose check would read `VAULT_RENEWAL=false` as `'false'` and leave renewal on -- the
     * exact hang the flag exists to prevent, silently.
     *
     * @param {Object} [authConfig]
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
     * @param {Object} [authConfig]
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
     * @param {Object} [authConfig]
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
            this.__renewalEpoch++;

            if (authToken.isRenewable() || renewableWithoutExpiry(authToken)) {
                // __setupTokenRefreshTimer logs once it has actually armed a timer, and warns
                // when it cannot; this covers the remaining case, the one diagnostic an operator
                // reads when a `renewal: false` process still hangs.
                if (!this.__renewalEnabled) {
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
        this.__renewalEpoch++;
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

        if (!this.__renewalEnabled) {
            return;
        }
        if (!authToken.isRenewable() || authToken.isExpired()) {
            let reason = 'token is not renewable';
            if (authToken.isExpired()) {
                reason = 'token already expired';
            } else if (renewableWithoutExpiry(authToken)) {
                reason = 'token has no usable expiry';
            }
            warnRenewalStopped(this, authToken, reason);
            return;
        }

        const expiry = tokenExpiryMilliseconds(authToken);
        if (expiry === null) {
            warnRenewalStopped(this, authToken, 'token has no usable expiry');
            return;
        }

        const remaining = expiry - Date.now();
        if (remaining <= 0) {
            warnRenewalStopped(this, authToken, 'token already expired');
            return;
        }

        const timer = Math.max(
            Math.floor(remaining * this.__renewalFraction),
            250
        );
        if (timer >= remaining) {
            warnRenewalStopped(this, authToken, 'too little lifetime left to renew');
            return;
        }

        // A renewal that is still in flight when the token is replaced or cancelled must not
        // act on what it finds when it lands: it would overwrite the newer token, or clear
        // the newer token's timer and then bail on its own expired one, leaving a live token
        // permanently un-renewed. Anything that supersedes this timer bumps the epoch.
        const epoch = ++this.__renewalEpoch;
        const superseded = () => this.__renewalEpoch !== epoch;

        this.__refreshTimeout = lt.setTimeout(() => {
            if (superseded()) {
                return;
            }
            this.__refreshTimeout = null;

            // Two handlers, not .then().catch(): once the renewed token is adopted, a failure
            // in the bookkeeping below must not be mistaken for a failed renewal and re-arm a
            // timer against the token this client no longer holds.
            this.__renewToken(authToken).then(({ renewedToken, cappedByMaxTtl }) => {
                if (superseded()) {
                    return;
                }
                this.__authToken = renewedToken;
                if (cappedByMaxTtl) {
                    warnRenewalStopped(this, renewedToken, 'Vault capped the renewal at the token\'s maximum TTL');
                    return;
                }
                this.__setupTokenRefreshTimer(renewedToken);
            }, err => {
                if (superseded()) {
                    return;
                }
                this.__setupTokenRefreshTimer(authToken);

                const message = `Cannot refresh auth token with "${authToken.getAccessor()}" accessor.`;
                // Dumping a VaultHttpError would print its raw response body, so it gets the safe
                // message only. Any other error is logged whole: its stack already has the message.
                if (err instanceof errors.VaultHttpError) {
                    this._log.error(`${message} Error: ${safeMessage(err)}`);
                } else {
                    this._log.error(message, err);
                }
            }).catch(err => {
                // Only a throwing logger (or a broken duck-typed token) gets here. Report it if
                // the logger allows, and never let it surface as an unhandled rejection.
                try {
                    this._log.error('token renewal bookkeeping failed: %s', safeMessage(err));
                } catch {
                    // nothing left to report to
                }
            });
        }, timer);

        this._log.debug(
            'renewal timer armed (accessor=%s); renewing in %s',
            authToken.getAccessor(),
            humanizeMs(timer)
        );
    }

    /**
     * @param {AuthToken} authToken
     * @returns {Promise.<{renewedToken: AuthToken, cappedByMaxTtl: boolean}>}
     * @private
     */
    __renewToken(authToken) {
        this._log.debug('renewing vault token');

        // null, not {}, when unset: that is the body the client has always sent.
        const data = this.__renewalIncrement === undefined ? null : {increment: this.__renewalIncrement};

        return this.__apiClient.makeRequest('POST', '/auth/token/renew-self', data, {'X-Vault-Token': authToken.getId()})
            .then((renewResponse) => {
                this._log.info('successfully renewed token');
                const cappedByMaxTtl = renewalCappedByMaxTtl(renewResponse);
                return this._getTokenEntity(authToken.getId())
                    .then((renewedToken) => ({ renewedToken, cappedByMaxTtl }));
            })
            .catch((reason) => {
                this._log.error('token renew failed: %s', safeMessage(reason));
                throw reason;
            });
    }
}

module.exports = VaultBaseAuth;
