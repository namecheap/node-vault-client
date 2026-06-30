'use strict';

const chai = require('chai');
const expect = chai.expect;

const Lease = require('../src/Lease');

describe('Lease', function () {
    const response = {
        request_id: 'req-1',
        lease_id: 'lease-1',
        lease_duration: 3600,
        renewable: true,
        data: { foo: 'bar', n: 42 },
    };

    it('fromResponse() maps fields and exposes data via getData()', function () {
        const lease = Lease.fromResponse(response);
        expect(lease).to.be.instanceof(Lease);
        expect(lease.getData()).to.deep.equal({ foo: 'bar', n: 42 });
        expect(lease.isRenewable()).to.equal(true);
    });

    it('getValue() returns the value for an existing key', function () {
        const lease = Lease.fromResponse(response);
        expect(lease.getValue('foo')).to.equal('bar');
        expect(lease.getValue('n')).to.equal(42);
    });

    it('getValue() throws for a missing key', function () {
        const lease = Lease.fromResponse(response);
        expect(function () { lease.getValue('nope'); }).to.throw('Requested key does not exist');
    });

    it('getData() returns a deep clone (mutating the result does not affect the lease)', function () {
        const lease = Lease.fromResponse(response);
        const data = lease.getData();
        data.foo = 'mutated';
        expect(lease.getData().foo).to.equal('bar');
    });

    it('defaults data to an empty object when the response has no data', function () {
        const lease = Lease.fromResponse({ request_id: 'r', lease_id: 'l', lease_duration: 0, renewable: false });
        expect(lease.getData()).to.deep.equal({});
        expect(lease.isRenewable()).to.equal(false);
    });

    it('constructor with undefined data yields an empty object', function () {
        const lease = new Lease('r', 'l', 0, false, undefined);
        expect(lease.getData()).to.deep.equal({});
    });
});
