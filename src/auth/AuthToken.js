'use strict';


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
     * @param {int|null} expiresAtMilliseconds - precise expiry time when available
     * @param {int|null} ttl - remaining lifetime reported by Vault, when available
     * @param {boolean} hasPreciseExpiry - true when expiry came from Vault's expire_time
     */
    constructor(
        id,
        accessor,
        createdAt,
        expiresAt,
        explicitMaxTtl,
        numUses,
        isRenewable,
        expiresAtMilliseconds = null,
        ttl = null,
        hasPreciseExpiry = false
    ) {
        this.__id = id;
        this.__accessor = accessor;
        this.__createdAt = createdAt;
        this.__expiresAtMilliseconds = expiresAt === null
            ? expiresAtMilliseconds
            : (expiresAtMilliseconds ?? expiresAt * 1000);
        this.__expiresAt = this.__expiresAtMilliseconds === null
            ? null
            : Math.floor(this.__expiresAtMilliseconds / 1000);
        this.__hasPreciseExpiry = hasPreciseExpiry;
        this.__explicitMaxTtl = explicitMaxTtl;
        this.__numUses = numUses;
        this.__isRenewable = isRenewable
            && (ttl === null || ttl === undefined || Number(ttl) !== 0)
            && this.__expiresAtMilliseconds !== null;
    }

    static fromResponse(response) {
        const data = response.data;
        const hasPreciseExpiry = AuthToken.__parseRfc3339Milliseconds(data.expire_time) !== null;
        const expiresAtMilliseconds = AuthToken.__resolveExpiresAtMilliseconds(data);

        return new AuthToken(
            data.id,
            data.accessor,
            data.creation_time,
            null,
            data.explicit_max_ttl,
            data.num_uses,
            data.renewable !== undefined ? data.renewable : false,
            expiresAtMilliseconds,
            data.ttl,
            hasPreciseExpiry
        );
    }

    /**
     * Resolve the UNIX timestamp (milliseconds) at which the client should treat the token
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
     * @returns {int|null} expiry in milliseconds, or null when ttl is 0 without expire_time
     */
    static __resolveExpiresAtMilliseconds(data) {
        const expireTime = AuthToken.__parseRfc3339Milliseconds(data.expire_time);
        const networkLatency = 60;
        const margin = data.ttl > networkLatency ? networkLatency : 1;

        if (expireTime !== null) {
            return expireTime - margin * 1000;
        }

        if (data.ttl === 0) {
            return null;
        }

        // Fallback for responses without a usable `expire_time`.
        const creationTime = parseInt(data.last_renewal_time !== undefined ? data.last_renewal_time : data.creation_time, 10);
        const ttl = data.ttl > networkLatency ? data.ttl - networkLatency : data.ttl;
        return (creationTime + parseInt(ttl, 10)) * 1000;
    }

    /**
     * Parse an RFC3339 timestamp (as returned by Vault, up to nanosecond precision with
     * a timezone offset) into UNIX milliseconds. Returns null for missing, empty,
     * unparseable, or non-positive (e.g. Vault's "0001-01-01T00:00:00Z" zero value) input.
     *
     * @private
     * @param {String} value
     * @returns {int|null}
     */
    static __parseRfc3339Milliseconds(value) {
        if (typeof value !== 'string' || value === '') {
            return null;
        }

        const ms = Date.parse(value);
        if (isNaN(ms)) {
            return null;
        }

        return ms > 0 ? ms : null;
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

        if (this.__hasPreciseExpiry) {
            return Date.now() >= this.__expiresAtMilliseconds;
        }

        // Preserve the previous whole-second boundary for tokens that do not carry
        // Vault's authoritative expire_time.
        return Math.floor(Date.now() / 1000) > this.__expiresAt;
    }

    /**
     * @returns {boolean}
     */
    isRenewable() {
        return this.__isRenewable;
    }

    /**
     * @returns {int|null} UNIX timestamp
     */
    getExpiresAt() {
        return this.__expiresAt;
    }

    /**
     * @returns {int|null} precise UNIX timestamp in milliseconds, when available
     */
    getExpiresAtMilliseconds() {
        return this.__expiresAtMilliseconds;
    }

    /**
     * @returns {boolean}
     */
    hasPreciseExpiry() {
        return this.__hasPreciseExpiry;
    }
}

module.exports = AuthToken;
