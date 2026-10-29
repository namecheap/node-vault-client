import { expect } from 'chai';
import sinon from 'sinon';
import AuthToken from '../src/auth/AuthToken.js';

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

        it('does not subtract a one-second margin from a positive short TTL', function () {
            const token = build({ ttl: 30, expire_time: '2030-01-01T00:00:00Z' });
            expect(token.getExpiresAt()).to.equal(epoch('2030-01-01T00:00:00Z'));
        });

        it('does not expire a one-second token immediately on receipt', function () {
            const clock = sinon.useFakeTimers({ now: 1000 });
            try {
                const token = build({ ttl: 1, expire_time: new Date(2000).toISOString() });
                expect(token.getExpiresAtMilliseconds()).to.equal(2000);
                expect(token.isExpired()).to.equal(false);
                clock.tick(999);
                expect(token.isExpired()).to.equal(false);
                clock.tick(1);
                expect(token.isExpired()).to.equal(true);
            } finally {
                clock.restore();
            }
        });

        it('keeps the 60-second safety margin above the short-ttl range', function () {
            const token = build({ ttl: 61, expire_time: '2030-01-01T00:00:00Z' });
            expect(token.getExpiresAt()).to.equal(epoch('2030-01-01T00:00:00Z') - 60);
        });

        it('uses expire_time for a token looked up long after issuance (the fix)', function () {
            const token = build({ creation_time: 1000, ttl: 100, expire_time: '2031-06-01T12:00:00Z' });
            expect(token.getExpiresAt()).to.equal(epoch('2031-06-01T12:00:00Z') - 60);
            expect(token.getExpiresAt()).to.not.equal(1000 + 100);
        });

        it('parses Vault RFC3339 with nanoseconds and a timezone offset', function () {
            const expireTime = '2030-05-19T11:35:54.466476215-04:00';
            const token = build({ ttl: 3600, expire_time: expireTime });
            expect(token.getExpiresAt()).to.equal(epoch(expireTime) - 60);
            expect(token.getExpiresAtMilliseconds()).to.equal(Date.parse(expireTime) - 60000);
            expect(token.hasPreciseExpiry()).to.equal(true);
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

        it('treats ttl 0 as expired on receipt even when the client clock trails Vault', function () {
            const clock = sinon.useFakeTimers({ now: 1000 });
            try {
                const token = build({ ttl: 0, expire_time: new Date(2800).toISOString() });
                expect(token.getExpiresAtMilliseconds()).to.equal(1000);
                expect(token.getUnadjustedExpiresAtMilliseconds()).to.equal(2800);
                expect(token.getExpiresAt()).to.equal(1);
                expect(token.isExpired()).to.equal(true);
                expect(token.isRenewable()).to.equal(false);
            } finally {
                clock.restore();
            }
        });

        it('keeps a ttl 0 token non-expiring when expire_time is unusable', function () {
            for (const expireTime of ['', '0001-01-01T00:00:00Z']) {
                const token = build({ ttl: 0, expire_time: expireTime });
                expect(token.getExpiresAt()).to.equal(null);
                expect(token.isExpired()).to.equal(false);
            }
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

        it('preserves the existing whole-second boundary without an authoritative expire_time', function () {
            const clock = sinon.useFakeTimers({ now: 1999 });
            try {
                const token = new AuthToken('id', 'acc', 0, 1, 0, 0, true);
                expect(token.isExpired()).to.equal(false);
                clock.tick(1);
                expect(token.isExpired()).to.equal(true);
            } finally {
                clock.restore();
            }
        });
    });

    describe('constructor expiry normalization', function () {
        it('derives the seconds value from the millisecond deadline and applies the ttl-0 renewal rule once', function () {
            const token = new AuthToken('id', 'acc', 0, 9, 0, 0, true, 1999, 0, true);
            expect(token.getExpiresAtMilliseconds()).to.equal(1999);
            expect(token.getExpiresAt()).to.equal(1);
            expect(token.isRenewable()).to.equal(false);
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
