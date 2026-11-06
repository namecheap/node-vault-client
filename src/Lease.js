'use strict';

class Lease {
    constructor(
        requestId,
        leaseId,
        leaseDuration,
        renewable,
        data,
        metadata
    ) {
        this.__requestId = requestId;
        this.__leaseId = leaseId;
        this.__leaseDuration = leaseDuration;
        this.__renewable = renewable;
        this.__data = data === undefined ? {} : data;
        this.__metadata = metadata;
    }

    static fromResponse(response) {
        return new Lease(
            response.request_id,
            response.lease_id,
            response.lease_duration,
            response.renewable,
            response.data,
            response.metadata
        );
    }

    /**
     * @param {String|number} key - a field name, or an index when the data is an array (a list)
     * @returns {*} the field's value as Vault returned it: a string for most secrets, but
     *      `null`, `false`, `0`, an object or an array are returned as they are
     * @throws {Error} 'Requested key does not exist' unless `key` is an own property of the
     *      response data whose value is not `undefined`
     */
    getValue(key) {
        const data = this.__data;
        // Own fields only: an inherited member such as `constructor` or `__proto__` is not
        // something Vault returned.
        if (data === null || typeof data !== 'object' || !Object.hasOwn(data, key) || data[key] === undefined) {
            throw new Error('Requested key does not exist');
        }

        return data[key];
    }

    /**
     * @returns {Object}
     */
    getData() {
        return structuredClone(this.__data);
    }

    /**
     * @returns {bool}
     */
    isRenewable() {
        return this.__renewable;
    }

    /**
     * KV v2 version metadata object (created_time, version, etc.).
     * Returns undefined for KV v1 / non-KV leases.
     *
     * @returns {Object|undefined}
     */
    getMetadata() {
        return this.__metadata;
    }
}

module.exports = Lease;
