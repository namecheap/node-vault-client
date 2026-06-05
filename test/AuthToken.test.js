'use strict';

const chai = require('chai');
const expect = chai.expect;

const AuthToken = require('../src/auth/AuthToken');

const nowSec = () => Math.floor(Date.now() / 1000);

describe('AuthToken', function () {
    describe('.fromResponse()', function () {
        function build(dataOverrides) {
            return AuthToken.fromResponse({
                data: Object.assign({
                    id: 'tok-id',
                    accessor: 'tok-accessor',
                    creation_time: 1000,
                    ttl: 3600,
                    explicit_max_ttl: 0,
                    num_uses: 0,
                    renewable: true,
                }, dataOverrides),
            });
        }

        it('maps id and accessor', function () {
            const token = build();
            expect(token.getId()).to.equal('tok-id');
            expect(token.getAccessor()).to.equal('tok-accessor');
        });

        it('subtracts the 60s network latency for a ttl greater than the latency', function () {
            // creation_time 1000 + (3600 - 60) = 4540
            const token = build({ ttl: 3600 });
            expect(token.getExpiresAt()).to.equal(4540);
        });

        it('keeps the ttl untouched when it is below the network latency', function () {
            // creation_time 1000 + 30 = 1030
            const token = build({ ttl: 30 });
            expect(token.getExpiresAt()).to.equal(1030);
        });

        it('produces a null expiry for a ttl of 0', function () {
            const token = build({ ttl: 0 });
            expect(token.getExpiresAt()).to.equal(null);
        });

        it('prefers last_renewal_time over creation_time when present', function () {
            // last_renewal_time 2000 + (3600 - 60) = 5540
            const token = build({ last_renewal_time: 2000, ttl: 3600 });
            expect(token.getExpiresAt()).to.equal(5540);
        });

        it('treats a missing renewable flag as not renewable', function () {
            const token = build({ renewable: undefined, ttl: 3600 });
            expect(token.isRenewable()).to.equal(false);
        });
    });

    describe('#isExpired()', function () {
        it('is never expired when there is no expiry', function () {
            const token = new AuthToken('id', 'acc', 0, null, 0, 0, false);
            expect(token.isExpired()).to.equal(false);
        });

        it('is expired when the expiry is in the past', function () {
            const token = new AuthToken('id', 'acc', 0, nowSec() - 100, 0, 0, true);
            expect(token.isExpired()).to.equal(true);
        });

        it('is not expired when the expiry is in the future', function () {
            const token = new AuthToken('id', 'acc', 0, nowSec() + 1000, 0, 0, true);
            expect(token.isExpired()).to.equal(false);
        });
    });

    describe('#isRenewable()', function () {
        it('is renewable when the flag is set and an expiry exists', function () {
            const token = new AuthToken('id', 'acc', 0, nowSec() + 1000, 0, 0, true);
            expect(token.isRenewable()).to.equal(true);
        });

        it('is not renewable without an expiry even when the flag is set', function () {
            const token = new AuthToken('id', 'acc', 0, null, 0, 0, true);
            expect(token.isRenewable()).to.equal(false);
        });

        it('is not renewable when the flag is unset', function () {
            const token = new AuthToken('id', 'acc', 0, nowSec() + 1000, 0, 0, false);
            expect(token.isRenewable()).to.equal(false);
        });
    });
});
