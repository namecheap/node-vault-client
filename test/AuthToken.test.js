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

    describe('.fromResponse() expire_time handling', function () {
        const epoch = (s) => Math.floor(Date.parse(s) / 1000);
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

        it('prefers the authoritative expire_time over creation_time + ttl', function () {
            const token = build({ creation_time: 1000, ttl: 3600, expire_time: '2030-01-01T00:00:00Z' });
            expect(token.getExpiresAt()).to.equal(epoch('2030-01-01T00:00:00Z') - 60);
        });

        it('does not subtract the margin when the remaining ttl is below the latency', function () {
            const token = build({ ttl: 30, expire_time: '2030-01-01T00:00:00Z' });
            expect(token.getExpiresAt()).to.equal(epoch('2030-01-01T00:00:00Z'));
        });

        it('uses expire_time for a token looked up long after issuance (the fix)', function () {
            // Aged token: created long ago, only 100s of ttl remaining. The old code
            // returned creation_time + remaining_ttl (wrong); the fix uses expire_time.
            const token = build({ creation_time: 1000, ttl: 100, expire_time: '2031-06-01T12:00:00Z' });
            expect(token.getExpiresAt()).to.equal(epoch('2031-06-01T12:00:00Z') - 60);
            expect(token.getExpiresAt()).to.not.equal(1000 + 100);
        });

        it('parses Vault RFC3339 with nanoseconds and a timezone offset', function () {
            const token = build({ ttl: 3600, expire_time: '2030-05-19T11:35:54.466476215-04:00' });
            expect(token.getExpiresAt()).to.equal(epoch('2030-05-19T11:35:54.466476215-04:00') - 60);
        });

        it('falls back to creation_time + ttl when expire_time is absent', function () {
            const token = build({ creation_time: 1000, ttl: 3600 });
            expect(token.getExpiresAt()).to.equal(1000 + (3600 - 60));
        });

        it('falls back when expire_time is an empty string', function () {
            const token = build({ creation_time: 1000, ttl: 3600, expire_time: '' });
            expect(token.getExpiresAt()).to.equal(1000 + (3600 - 60));
        });

        it('falls back when expire_time is the Vault zero value', function () {
            const token = build({ creation_time: 1000, ttl: 3600, expire_time: '0001-01-01T00:00:00Z' });
            expect(token.getExpiresAt()).to.equal(1000 + (3600 - 60));
        });

        it('never expires when ttl is 0, even if expire_time is present', function () {
            const token = build({ ttl: 0, expire_time: '2030-01-01T00:00:00Z' });
            expect(token.getExpiresAt()).to.equal(null);
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
