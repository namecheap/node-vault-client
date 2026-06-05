import { expect } from 'chai';
import Lease from '../src/Lease.js';

describe('Lease', function () {
    const response = {
        request_id: 'req-1',
        lease_id: 'lease-1',
        lease_duration: 3600,
        renewable: true,
        data: { foo: 'bar', num: 42 },
    };

    describe('constructor', function () {
        it('stores provided data', function () {
            const lease = new Lease('r', 'l', 10, false, { a: 1 });
            expect(lease.getData()).to.deep.equal({ a: 1 });
            expect(lease.isRenewable()).to.equal(false);
        });

        it('defaults data to an empty object when undefined', function () {
            const lease = new Lease('r', 'l', 10, false, undefined);
            expect(lease.getData()).to.deep.equal({});
        });
    });

    describe('.fromResponse()', function () {
        it('maps a Vault response onto a Lease', function () {
            const lease = Lease.fromResponse(response);
            expect(lease).to.be.instanceOf(Lease);
            expect(lease.isRenewable()).to.equal(true);
            expect(lease.getData()).to.deep.equal(response.data);
        });
    });

    describe('#getValue()', function () {
        it('returns the value for an existing key', function () {
            const lease = Lease.fromResponse(response);
            expect(lease.getValue('foo')).to.equal('bar');
            expect(lease.getValue('num')).to.equal(42);
        });

        it('throws when the key does not exist', function () {
            const lease = Lease.fromResponse(response);
            expect(() => lease.getValue('missing')).to.throw('Requested key does not exist');
        });
    });

    describe('#getData()', function () {
        it('returns a deep clone (mutating the result keeps the lease intact)', function () {
            const lease = Lease.fromResponse(response);
            const data = lease.getData();
            data.foo = 'mutated';
            expect(lease.getValue('foo')).to.equal('bar');
            expect(lease.getData()).to.deep.equal(response.data);
        });
    });

    describe('#isRenewable()', function () {
        it('reflects the renewable flag', function () {
            expect(new Lease('r', 'l', 10, true, {}).isRenewable()).to.equal(true);
            expect(new Lease('r', 'l', 10, false, {}).isRenewable()).to.equal(false);
        });
    });
});
