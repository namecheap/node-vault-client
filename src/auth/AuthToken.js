'use strict';

const _ = require('lodash');

class AuthToken {

    /**
     *
     * @param {string} id
     * @param {string} accessor
     * @param {int} createdAt - UNIX timestamp
     * @param {int|null} expiresAt - UNIX timestamp
     * @param {int} explicitMaxTtl - in seconds
     * @param {int} numUses
     * @param {boolean} isRenewable
     */
    constructor(
        id,
        accessor,
        createdAt,
        expiresAt,
        explicitMaxTtl,
        numUses,
        isRenewable
    ) {
        this.__id = id;
        this.__accessor = accessor;
        this.__createdAt = createdAt;
        this.__expiresAt = expiresAt;
        this.__explicitMaxTtl = explicitMaxTtl;
        this.__numUses = numUses;
        this.__isRenewable = isRenewable;
    }

    static fromResponse(response) {
        const data = response.data;

        return new AuthToken(
            data.id,
            data.accessor,
            data.creation_time,
            AuthToken.__resolveExpiresAt(data),
            data.explicit_max_ttl,
            data.num_uses,
            data.renewable !== undefined ? data.renewable : false
        );
    }

    /**
     * Resolve the UNIX timestamp (seconds) at which the client should treat the token
     * as expired, shifted earlier by a network-latency safety margin so renewal happens
     * before the real expiry.
     *
     * Prefers Vault's authoritative `expire_time` (RFC3339), which is the documented
     * absolute expiry. Falls back to `(last_renewal_time || creation_time) + ttl` for
     * responses that don't carry `expire_time` — note `ttl` is the *remaining* lifetime,
     * so that sum is only accurate when the lookup happens right after issuance/renewal.
     *
     * @private
     * @param {Object} data - the `data` object of a token lookup response
     * @returns {int|null} null when the token never expires (ttl === 0)
     */
    static __resolveExpiresAt(data) {
        if (data.ttl === 0) {
            return null;
        }

        const networkLatency = 60;
        const margin = data.ttl > networkLatency ? networkLatency : 0;

        const expireTime = AuthToken.__parseRfc3339Seconds(data.expire_time);
        if (expireTime !== null) {
            return expireTime - margin;
        }

        // Fallback for responses without a usable `expire_time`.
        const creationTime = parseInt(data.last_renewal_time !== undefined ? data.last_renewal_time : data.creation_time, 10);
        const ttl = data.ttl > networkLatency ? data.ttl - networkLatency : data.ttl;
        return creationTime + parseInt(ttl, 10);
    }

    /**
     * Parse an RFC3339 timestamp (as returned by Vault, up to nanosecond precision with
     * a timezone offset) into whole UNIX seconds. Returns null for missing, empty,
     * unparseable, or non-positive (e.g. Vault's "0001-01-01T00:00:00Z" zero value) input.
     *
     * @private
     * @param {String} value
     * @returns {int|null}
     */
    static __parseRfc3339Seconds(value) {
        if (typeof value !== 'string' || value === '') {
            return null;
        }

        const ms = Date.parse(value);
        if (isNaN(ms)) {
            return null;
        }

        const seconds = Math.floor(ms / 1000);
        return seconds > 0 ? seconds : null;
    }

    /**
     * @returns {string}
     */
    getId() {
        return this.__id;
    }

    getAccessor() {
        return this.__accessor;
    }

    /**
     * @returns {boolean}
     */
    isExpired() {
        if (this.__expiresAt === null) {
            return false;
        }

        return Math.floor(Date.now() / 1000) > this.__expiresAt;
    }

    /**
     * @returns {boolean}
     */
    isRenewable() {
        return this.__isRenewable && this.getExpiresAt() !== null;
    }

    /**
     * @returns {int|null} UNIX timestamp
     */
    getExpiresAt() {
        return this.__expiresAt;
    }
}

module.exports = AuthToken;
