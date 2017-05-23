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

        let expiresAt = null;
        if (data.ttl !== 0) {
            const creationTime = parseInt(data.last_renewal_time !== undefined ? data.last_renewal_time : data.creation_time, 10);
            const networkLatency = 60;
            const ttl = parseInt(data.ttl > networkLatency ? data.ttl - networkLatency : data.ttl);
            expiresAt = creationTime + ttl;
        }

        return new AuthToken(
            data.id,
            data.accessor,
            data.creation_time,
            expiresAt,
            data.explicit_max_ttl,
            data.num_uses,
            data.renewable !== undefined ? data.renewable : false
        );
    }

    /**
     * @returns {string}
     */
    getId() {
        return this.__id;
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
