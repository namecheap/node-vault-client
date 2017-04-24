'use strict';

const _ = require('lodash');

class Lease {
    constructor(
        requestId,
        leaseId,
        leaseDuration,
        renewable,
        data = {}
    ) {
        this.__requestId = requestId;
        this.__leaseId = leaseId;
        this.__leaseDuration = leaseDuration;
        this.__renewable = renewable;
        this.__data = data;
    }

    static fromResponse(response) {
        return new Lease(
            response.request_id,
            response.lease_id,
            response.lease_duration,
            response.renewable,
            response.data
        );
    }

    /**
     * @param {String} key
     * @returns {String}
     */
    getValue(key) {
        if (this.__data[key] === undefined) {
            throw new Error('Requested key does not exist');
        }

        return this.__data[key];
    }

    /**
     * @returns {Object}
     */
    getData() {
        return _.cloneDeep(this.__data);
    }

    /**
     * @returns {bool}
     */
    isRenewable() {
        return this.__renewable;
    }
}

module.exports = Lease;
