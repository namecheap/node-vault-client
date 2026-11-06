import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultBaseAuth from '../src/auth/VaultBaseAuth.js';
import AuthToken from '../src/auth/AuthToken.js';
import errors from '../src/errors.js';

use(sinonChai);

const LOG_METHODS = ['error', 'warn', 'info', 'debug', 'trace'];

const logger = _.fromPairs(_.map(LOG_METHODS, (p) => [p, _.noop]));

function spyLogger() {
    return _.fromPairs(_.map(LOG_METHODS, (p) => [p, sinon.spy()]));
}

// Flatten every argument passed to a logger call into a single searchable string,
// covering both printf-style args and object logging (%j / %o).
function loggedText(log) {
    return _.flatMap(LOG_METHODS, (m) => _.flatMap(log[m].getCalls(), (c) => c.args))
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
}

function apiStub() {
    return sinon.createStubInstance(VaultApiClient);
}

const nowSec = () => Math.floor(Date.now() / 1000);

class TestAuth extends VaultBaseAuth {
    constructor(api, mount, opts) {
        super(api, logger, mount);
        if ((opts || {}).config !== undefined) {
            // what VaultClient does with the `auth` block
            this.configureRenewal(opts.config);
        }
        opts = opts || {};
        this.__authStub = opts.authStub || sinon.stub();
        this.__reauth = opts.reauth !== undefined ? opts.reauth : true;
    }

    _authenticate() {
        return this.__authStub();
    }

    _reauthenticationAllowed() {
        return this.__reauth;
    }
}

/**
 * A `lookup-self` response body. Only the fields a case cares about need passing; the rest are
 * the values every renewal test used to spell out by hand.
 */
function lookupResponse({ id, accessor = 'acc', creationTime = 0, ttl, expireMs, renewable = true }) {
    const data = {
        id, accessor, creation_time: creationTime, ttl,
        explicit_max_ttl: 0, num_uses: 0, renewable,
    };
    if (expireMs !== undefined) {
        data.expire_time = new Date(expireMs).toISOString();
    }
    return { data };
}

/** The renew-self body Vault returns when a max TTL capped the renewal (measured on 1.21/2.2). */
function cappedRenewResponse(grantedSeconds = 9) {
    return {
        auth: { lease_duration: grantedSeconds, renewable: true },
        warnings: [`TTL of "10s" exceeded the effective max_ttl of "${grantedSeconds}s"; TTL value is capped accordingly`],
    };
}

function nonRenewableToken(id) {
    return new AuthToken(id || 'id', 'acc', 0, null, 0, 0, false);
}

/**
 * A renewable token expiring far enough out to arm a refresh timer.
 * AuthToken takes an absolute `expiresAt`, not a TTL.
 */
function renewableToken() {
    return new AuthToken('renewable-id', 'acc', nowSec(), nowSec() + 3600, 0, 0, true);
}

describe('VaultBaseAuth', function () {
    describe('config.renewal (#17)', function () {
        const created = [];

        function makeAuth(opts) {
            const auth = new TestAuth(apiStub(), 'mount', opts);
            created.push(auth);
            return auth;
        }

        afterEach(function () {
            // mocha runs test:unit without --exit, so a timer left armed by a failing
            // assertion would hang the entire suite rather than fail one test.
            created.splice(0).forEach((auth) => auth.cancelTokenRefresh());
            sinon.restore();
        });

        it('arms a refresh timer for a renewable token by default', async function () {
            const auth = makeAuth({ authStub: sinon.stub().resolves(renewableToken()) });
            await auth.getAuthToken();
            expect(auth.__refreshTimeout, 'a timer should be armed').to.not.equal(null);
        });

        it('arms no timer when config.renewal is false', async function () {
            const auth = makeAuth({
                authStub: sinon.stub().resolves(renewableToken()),
                config: { renewal: false },
            });
            const token = await auth.getAuthToken();
            expect(token.getId()).to.equal('renewable-id');
            expect(auth.__refreshTimeout, 'no timer should be armed').to.equal(null);
        });

        it('still serves the token from cache while it is valid', async function () {
            const authStub = sinon.stub().resolves(renewableToken());
            const auth = makeAuth({ authStub, config: { renewal: false } });
            await auth.getAuthToken();
            await auth.getAuthToken();
            expect(authStub, 'a valid token is reused, renewal or not').to.have.been.calledOnce;
        });

        it('re-authenticates once the un-renewed token expires', async function () {
            const authStub = sinon.stub();
            authStub.onFirstCall().resolves(new AuthToken('first', 'acc', nowSec() - 7200, nowSec() - 3600, 0, 0, true));
            authStub.onSecondCall().resolves(renewableToken());
            const auth = makeAuth({ authStub, config: { renewal: false } });
            await auth.getAuthToken();
            const second = await auth.getAuthToken();
            expect(authStub).to.have.been.calledTwice;
            expect(second.getId()).to.equal('renewable-id');
            auth.cancelTokenRefresh();
        });

        it('rejects a non-boolean renewal at construction', function () {
            // node-config's custom-environment-variables yields strings: VAULT_RENEWAL=false
            // arrives as 'false'. Accepting it silently would leave the timer armed, which is
            // precisely the hang the flag exists to prevent.
            for (const bad of ['false', 'true', 0, 1, null, {}]) {
                expect(
                    () => makeAuth({ config: { renewal: bad } }),
                    `renewal=${JSON.stringify(bad)} must be rejected`
                ).to.throw(errors.InvalidArgumentsError, 'renewal');
            }
        });

        it('does not disable re-authentication (only the background timer)', async function () {
            // Guards a plausible mis-implementation: wiring _reauthenticationAllowed() to the
            // renewal flag would still pass every other test here, because TestAuth overrides
            // that method. This subclass deliberately does not.
            class PlainAuth extends VaultBaseAuth {
                constructor(api, config) {
                    super(api, logger, 'mount');
                    this.configureRenewal(config);
                    this.calls = 0;
                }

                _authenticate() {
                    this.calls++;
                    return Promise.resolve(
                        this.calls === 1
                            ? new AuthToken('expired', 'acc', nowSec() - 7200, nowSec() - 3600, 0, 0, true)
                            : renewableToken()
                    );
                }
            }

            const auth = new PlainAuth(apiStub(), { renewal: false });
            created.push(auth);
            await auth.getAuthToken();
            const second = await auth.getAuthToken();
            expect(auth.calls, 'an expired token must still trigger a fresh login').to.equal(2);
            expect(second.getId()).to.equal('renewable-id');
        });

        it('treats any value other than false as renewal enabled', async function () {
            for (const renewal of [undefined, true]) {
                const auth = makeAuth({
                    authStub: sinon.stub().resolves(renewableToken()),
                    config: { renewal },
                });
                await auth.getAuthToken();
                expect(auth.__refreshTimeout, `renewal=${String(renewal)} should arm a timer`).to.not.equal(null);
            }
        });
    });

    describe('abstract members', function () {
        it('_authenticate must be overridden', function () {
            const auth = new VaultBaseAuth(apiStub(), logger, 'mount');
            expect(() => auth._authenticate()).to.throw('Method should be overridden');
        });

        it('allows reauthentication by default', function () {
            const auth = new VaultBaseAuth(apiStub(), logger, 'mount');
            expect(auth._reauthenticationAllowed()).to.equal(true);
        });
    });

    describe('#_getTokenEntity()', function () {
        it('looks the token up via /auth/token/lookup-self', function () {
            const api = apiStub();
            api.makeRequest.resolves({
                data: { id: 't', accessor: 'a', creation_time: 1000, ttl: 0, renewable: false },
            });
            const auth = new VaultBaseAuth(api, logger, 'mount');
            return auth._getTokenEntity('my-token').then((token) => {
                expect(api.makeRequest).to.have.been.calledWith('GET', '/auth/token/lookup-self', null, { 'X-Vault-Token': 'my-token' });
                expect(token).to.be.instanceOf(AuthToken);
                expect(token.getId()).to.equal('t');
            });
        });
    });

    describe('#getAuthToken()', function () {
        it('rejects, instead of throwing, when a backend\'s _authenticate() throws (#241)', async function () {
            const boom = new Error('credential source unreadable');
            const authStub = sinon.stub();
            authStub.onFirstCall().throws(boom);
            authStub.onSecondCall().resolves(nonRenewableToken('second'));
            const auth = new TestAuth(apiStub(), 'mount', { authStub });

            let pending;
            expect(() => { pending = auth.getAuthToken(); }).to.not.throw();
            // A caller in the same tick joins that one failed login, as with any other.
            expect(auth.getAuthToken()).to.equal(pending);
            expect(await pending.then(() => null, (err) => err)).to.equal(boom);
            expect(authStub).to.have.been.calledOnce;
            expect(auth.__pendingLogin).to.equal(null);

            expect((await auth.getAuthToken()).getId()).to.equal('second');
        });

        it('authenticates once and caches the token for subsequent calls', function () {
            const token = nonRenewableToken();
            const authStub = sinon.stub().resolves(token);
            const auth = new TestAuth(apiStub(), 'mount', { authStub });

            return auth.getAuthToken()
                .then((first) => {
                    expect(first).to.equal(token);
                    return auth.getAuthToken();
                })
                .then((second) => {
                    expect(second).to.equal(token);
                    expect(authStub).to.have.been.calledOnce;
                });
        });

        it('re-authenticates when the cached token expired and reauth is allowed', function () {
            const expired = new AuthToken('old', 'acc', 0, nowSec() - 100, 0, 0, false);
            const fresh = nonRenewableToken('new');
            const authStub = sinon.stub();
            authStub.onCall(0).resolves(expired);
            authStub.onCall(1).resolves(fresh);
            const auth = new TestAuth(apiStub(), 'mount', { authStub, reauth: true });

            return auth.getAuthToken()
                .then((t1) => {
                    expect(t1).to.equal(expired);
                    return auth.getAuthToken();
                })
                .then((t2) => {
                    expect(t2).to.equal(fresh);
                    expect(authStub).to.have.been.calledTwice;
                });
        });

        it('rejects with AuthTokenExpiredError when the cached token expired and reauth is disallowed', function () {
            const expired = new AuthToken('old', 'acc', 0, nowSec() - 100, 0, 0, false);
            const authStub = sinon.stub().resolves(expired);
            const auth = new TestAuth(apiStub(), 'mount', { authStub, reauth: false });

            return auth.getAuthToken()
                .then((t1) => {
                    expect(t1).to.equal(expired);
                    return auth.getAuthToken().then(
                        () => { throw new Error('expected rejection'); },
                        (err) => {
                            expect(err).to.be.instanceOf(errors.AuthTokenExpiredError);
                            expect(authStub).to.have.been.calledOnce;
                        }
                    );
                });
        });

        it('coalesces concurrent callers onto a single in-flight login', function () {
            const token = nonRenewableToken();
            let release;
            const authStub = sinon.stub().returns(new Promise((resolve) => { release = () => resolve(token); }));
            const auth = new TestAuth(apiStub(), 'mount', { authStub });

            // Both calls happen while the login is still pending, so they must share it.
            const first = auth.getAuthToken();
            const second = auth.getAuthToken();
            expect(authStub).to.have.been.calledOnce;

            release();

            return Promise.all([first, second]).then(([t1, t2]) => {
                expect(t1).to.equal(token);
                expect(t2).to.equal(token);
                expect(authStub).to.have.been.calledOnce;
                // Once resolved, the pending-login slot is cleared and the token is cached.
                expect(auth.__pendingLogin).to.equal(null);
                expect(auth.__authToken).to.equal(token);
                return auth.getAuthToken();
            }).then((t3) => {
                expect(t3).to.equal(token);
                expect(authStub).to.have.been.calledOnce;
            });
        });

        it('clears the in-flight login when it fails, so a later call retries', function () {
            const boom = new Error('auth failed');
            const authStub = sinon.stub().rejects(boom);
            const auth = new TestAuth(apiStub(), 'mount', { authStub });

            return auth.getAuthToken().then(
                () => { throw new Error('expected rejection'); },
                (err) => {
                    expect(err).to.equal(boom);
                    expect(auth.__pendingLogin).to.equal(null);
                    expect(auth.__authToken).to.equal(null);
                }
            );
        });

        it('resets state and propagates the error when authentication fails, allowing a retry', function () {
            const boom = new Error('auth failed');
            const token = nonRenewableToken();
            const authStub = sinon.stub();
            authStub.onCall(0).rejects(boom);
            authStub.onCall(1).resolves(token);
            const auth = new TestAuth(apiStub(), 'mount', { authStub });

            return auth.getAuthToken()
                .then(
                    () => { throw new Error('expected rejection'); },
                    (err) => {
                        expect(err).to.equal(boom);
                        return auth.getAuthToken();
                    }
                )
                .then((t) => {
                    expect(t).to.equal(token);
                    expect(authStub).to.have.been.calledTwice;
                });
        });
    });

    describe('config.renewalFraction / config.renewalIncrement (#17)', function () {
        let clock;

        function flush(times) {
            let p = Promise.resolve();
            for (let i = 0; i < (times || 8); i++) {
                p = p.then(() => undefined);
            }
            return p;
        }

        // expiresAt 100s with the clock at 0: the default halfway point is 50s.
        function renewableFor100s() {
            return new AuthToken('rid', 'racc', 0, 100, 0, 0, true);
        }

        function armedAuth(config) {
            const api = apiStub();
            api.makeRequest.resolves({});
            const auth = new TestAuth(api, 'mount', {
                authStub: sinon.stub().resolves(renewableFor100s()),
                config,
            });
            sinon.stub(auth, '_getTokenEntity').resolves(nonRenewableToken('rid2'));
            return { auth, api };
        }

        beforeEach(function () {
            clock = sinon.useFakeTimers();
        });

        afterEach(function () {
            clock.restore();
            sinon.restore();
        });

        it('renews at the halfway point by default (unchanged)', function () {
            const { auth, api } = armedAuth(undefined);
            return auth.getAuthToken()
                .then(() => {
                    clock.tick(49999);
                    return flush();
                })
                .then(() => {
                    expect(api.makeRequest, 'must not renew before half the lifetime').to.not.have.been.called;
                    clock.tick(1);
                    return flush();
                })
                .then(() => {
                    expect(api.makeRequest).to.have.been.calledWith('POST', '/auth/token/renew-self');
                });
        });

        it('renews earlier with a smaller renewalFraction', function () {
            const { auth, api } = armedAuth({ renewalFraction: 0.25 });
            return auth.getAuthToken()
                .then(() => {
                    clock.tick(24999);
                    return flush();
                })
                .then(() => {
                    expect(api.makeRequest).to.not.have.been.called;
                    clock.tick(1);
                    return flush();
                })
                .then(() => {
                    expect(api.makeRequest, 'should renew at a quarter of the lifetime').to.have.been.called;
                });
        });

        it('sends no increment by default (unchanged)', function () {
            const { auth, api } = armedAuth(undefined);
            return auth.getAuthToken()
                .then(() => {
                    clock.tick(50000);
                    return flush();
                })
                .then(() => {
                    expect(api.makeRequest).to.have.been.calledWith(
                        'POST', '/auth/token/renew-self', null, { 'X-Vault-Token': 'rid' }
                    );
                });
        });

        it('sends the configured renewalIncrement to renew-self', function () {
            const { auth, api } = armedAuth({ renewalIncrement: 3600 });
            return auth.getAuthToken()
                .then(() => {
                    clock.tick(50000);
                    return flush();
                })
                .then(() => {
                    expect(api.makeRequest).to.have.been.calledWith(
                        'POST', '/auth/token/renew-self', { increment: 3600 }, { 'X-Vault-Token': 'rid' }
                    );
                });
        });

        it('uses sub-second expire_time precision when scheduling a renewal', async function () {
            clock.setSystemTime(1000);
            const api = apiStub();
            api.makeRequest.onFirstCall().resolves({});
            api.makeRequest.onSecondCall().resolves(lookupResponse({ id: 'renewed', creationTime: 1, ttl: 0, expireMs: 10000 }));
            const initial = AuthToken.fromResponse(lookupResponse({ id: 'initial', creationTime: 1, ttl: 3600, expireMs: 62050 }));
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(initial) });

            try {
                await auth.getAuthToken();
                clock.tick(524);
                await flush();
                expect(api.makeRequest).to.not.have.been.called;

                clock.tick(1);
                await flush();
                expect(api.makeRequest.firstCall).to.have.been.calledWith(
                    'POST', '/auth/token/renew-self', null, { 'X-Vault-Token': 'initial' }
                );
                expect(auth.__authToken.getId()).to.equal('renewed');
            } finally {
                auth.cancelTokenRefresh();
            }
        });

        it('fires a short-ttl renewal before its millisecond expiry deadline', async function () {
            clock.setSystemTime(1000);
            const api = apiStub();
            api.makeRequest.onFirstCall().resolves({});
            api.makeRequest.onSecondCall().resolves(lookupResponse({ id: 'renewed', ttl: 0, expireMs: 10000 }));
            const initial = AuthToken.fromResponse(lookupResponse({ id: 'short-ttl', ttl: 1, expireMs: 2050 }));
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(initial) });

            try {
                await auth.getAuthToken();
                clock.tick(524);
                await flush();
                expect(api.makeRequest).to.not.have.been.called;

                clock.tick(1);
                await flush();
                expect(api.makeRequest.firstCall).to.have.been.calledWith(
                    'POST', '/auth/token/renew-self', null, { 'X-Vault-Token': 'short-ttl' }
                );
                expect(auth.__authToken.getId()).to.equal('renewed');
            } finally {
                auth.cancelTokenRefresh();
            }
        });

        it('still attempts renewal when the timer callback runs after the safety deadline', async function () {
            clock.setSystemTime(1000);
            const api = apiStub();
            api.makeRequest.onFirstCall().resolves({});
            api.makeRequest.onSecondCall().resolves(lookupResponse({ id: 'renewed-late', ttl: 3600, expireMs: 200000 }));
            const initial = AuthToken.fromResponse(lookupResponse({ id: 'late-callback', ttl: 61, expireMs: 62000 }));
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(initial) });

            try {
                await auth.getAuthToken();
                clock.setSystemTime(61000);
                clock.tick(500);
                await flush();

                expect(api.makeRequest.firstCall).to.have.been.calledWith(
                    'POST', '/auth/token/renew-self', null, { 'X-Vault-Token': 'late-callback' }
                );
                expect(auth.__authToken.getId()).to.equal('renewed-late');
            } finally {
                auth.cancelTokenRefresh();
            }
        });

        it('rearms when renewalIncrement meaningfully shortens the absolute expiry', async function () {
            clock.setSystemTime(1000);
            const api = apiStub();
            api.makeRequest.onFirstCall().resolves({});
            api.makeRequest.onSecondCall().resolves(lookupResponse({ id: 'short-increment', ttl: 10, expireMs: 41000 }));
            api.makeRequest.onThirdCall().resolves({});
            api.makeRequest.onCall(3).resolves(lookupResponse({ id: 'short-increment-again', ttl: 10, expireMs: 41000 }));
            const initial = AuthToken.fromResponse(lookupResponse({ id: 'before-short-increment', ttl: 61, expireMs: 62000 }));
            const auth = new TestAuth(api, 'mount', {
                authStub: sinon.stub().resolves(initial),
                config: { renewalIncrement: 10 },
            });

            try {
                await auth.getAuthToken();
                clock.tick(500);
                await flush();

                expect(api.makeRequest.firstCall).to.have.been.calledWith(
                    'POST', '/auth/token/renew-self', { increment: 10 }, { 'X-Vault-Token': 'before-short-increment' }
                );
                expect(auth.__authToken.getId()).to.equal('short-increment');
                expect(auth.__refreshTimeout, 'the materially earlier deadline must be rescheduled').to.not.equal(null);

                clock.tick(19749);
                await flush();
                expect(api.makeRequest).to.have.been.calledTwice;

                clock.tick(1);
                await flush();
                expect(api.makeRequest.thirdCall).to.have.been.calledWith(
                    'POST', '/auth/token/renew-self', { increment: 10 }, { 'X-Vault-Token': 'short-increment' }
                );
                expect(auth.__authToken.getId()).to.equal('short-increment-again');
            } finally {
                auth.cancelTokenRefresh();
            }
        });

        it('stops renewing when renew-self reports the max-TTL cap, whatever the expiry movement', async function () {
            // The old wall-clock rule needed the expiry to wobble by under a second; Vault's
            // warning is the signal now, so the movement no longer matters.
            for (const expiryDeltaMs of [500, -500, 5000]) {
                clock.setSystemTime(1000);
                const renewedExpiry = 62000 + expiryDeltaMs;
                const api = apiStub();
                api.makeRequest.onFirstCall().resolves(cappedRenewResponse(60));
                api.makeRequest.onSecondCall().resolves(lookupResponse({
                    id: `max-ttl-capped-${expiryDeltaMs}`, ttl: 60, expireMs: renewedExpiry,
                }));
                const initial = AuthToken.fromResponse(lookupResponse({ id: 'before-cap', ttl: 61, expireMs: 62000 }));
                const fresh = nonRenewableToken('after-cap');
                const authStub = sinon.stub();
                authStub.onFirstCall().resolves(initial);
                authStub.onSecondCall().resolves(fresh);
                const auth = new TestAuth(api, 'mount', { authStub });

                try {
                    await auth.getAuthToken();
                    clock.tick(500);
                    await flush();

                    expect(auth.__authToken.getId()).to.equal(`max-ttl-capped-${expiryDeltaMs}`);
                    expect(auth.__refreshTimeout).to.equal(null);
                    clock.tick(renewedExpiry - Date.now());
                    expect(await auth.getAuthToken()).to.equal(fresh);
                    expect(authStub).to.have.been.calledTwice;
                    expect(api.makeRequest).to.have.been.calledTwice;
                } finally {
                    auth.cancelTokenRefresh();
                }
            }
        });

        it('keeps renewing an uncapped token whose expiry did not move (increment equals the remaining lifetime)', async function () {
            // Measured on Vault 2.2: a -ttl=20s token renewed at 10 s with increment 10 keeps its
            // deadline (7 ms of movement) and returns no warning. The old rule stopped here.
            clock.setSystemTime(10000);
            const api = apiStub();
            api.makeRequest.callsFake((method) => Promise.resolve(method === 'POST'
                ? { auth: { lease_duration: 10, renewable: true }, warnings: null }
                : lookupResponse({ id: 'same-deadline', ttl: 10, expireMs: Date.now() + 10000 })));
            const initial = AuthToken.fromResponse(lookupResponse({ id: 'same-deadline', ttl: 20, expireMs: 30000 }));
            const auth = new TestAuth(api, 'mount', {
                authStub: sinon.stub().resolves(initial),
                config: { renewalIncrement: 10 },
            });
            const log = spyLogger();
            auth._log = log;

            try {
                await auth.getAuthToken();
                clock.tick(10000);
                await flush();
                expect(api.makeRequest).to.have.been.calledTwice;
                expect(auth.__refreshTimeout, 'an unmoved but uncapped deadline must be re-armed').to.not.equal(null);

                clock.tick(5000);
                await flush();
                expect(api.makeRequest.callCount, 'and renewed again').to.equal(4);
                expect(log.warn).to.not.have.been.called;
            } finally {
                auth.cancelTokenRefresh();
            }
        });

        it('keeps renewing a periodic token whose period Vault capped to the max TTL', async function () {
            // Measured on Vault 2.2: an AppRole with token_period 4s and token_max_ttl 2s (or a
            // period-5s token on a mount with max_lease_ttl 3s) gets this warning on EVERY
            // renewal and stays renewable indefinitely at the capped period. It mentions max_ttl
            // and "capped" but is not the max-TTL stop signal.
            clock.setSystemTime(10000);
            const api = apiStub();
            api.makeRequest.callsFake((method) => Promise.resolve(method === 'POST'
                ? {
                    auth: { lease_duration: 2, renewable: true },
                    warnings: ['period of "4s" exceeded the effective max_ttl of "2s"; period value is capped accordingly'],
                }
                : lookupResponse({ id: 'period-capped', ttl: 2, expireMs: Date.now() + 2000 })));
            const initial = AuthToken.fromResponse(lookupResponse({ id: 'period-capped', ttl: 2, expireMs: 12000 }));
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(initial) });
            const log = spyLogger();
            auth._log = log;

            try {
                await auth.getAuthToken();
                for (let i = 1; i <= 5; i++) {
                    clock.tick(1000);
                    await flush();
                    expect(api.makeRequest.callCount, `renewal ${i}`).to.equal(i * 2);
                }
                expect(auth.__refreshTimeout, 'still armed after five capped-period renewals').to.not.equal(null);
                expect(log.warn).to.not.have.been.called;
            } finally {
                auth.cancelTokenRefresh();
            }
        });

        it('supports duck-typed AuthToken objects from the public TypeScript interface', async function () {
            clock.setSystemTime(1000);
            const api = apiStub();
            api.makeRequest.onFirstCall().resolves({});
            api.makeRequest.onSecondCall().resolves(lookupResponse({ id: 'renewed-duck-token', ttl: 89, expireMs: 120000 }));
            const publicToken = {
                getId: () => 'public-token',
                getAccessor: () => 'acc',
                isExpired: () => Date.now() >= 62000,
                isRenewable: () => true,
                getExpiresAt: () => 62,
            };
            const auth = new TestAuth(api, 'mount', {
                authStub: sinon.stub().resolves(publicToken),
            });

            try {
                expect(await auth.getAuthToken()).to.equal(publicToken);
                expect(auth.__refreshTimeout, 'the public expiry getter should arm the first timer').to.not.equal(null);

                clock.tick(30500);
                await flush();

                expect(api.makeRequest).to.have.been.calledTwice;
                expect(auth.__authToken.getId()).to.equal('renewed-duck-token');
                expect(auth.__refreshTimeout, 'the renewal callback should remain compatible').to.not.equal(null);
            } finally {
                auth.cancelTokenRefresh();
            }
        });

        it('keeps a 250ms minimum delay for precise-expiry timers', async function () {
            clock.setSystemTime(1000);
            const api = apiStub();
            api.makeRequest.onFirstCall().resolves({});
            api.makeRequest.onSecondCall().resolves(lookupResponse({ id: 'renewed-min-delay', ttl: 3600, expireMs: 200000 }));
            const initial = AuthToken.fromResponse(lookupResponse({ id: 'near-expiry', ttl: 61, expireMs: 62000 }));
            const auth = new TestAuth(api, 'mount', {
                authStub: sinon.stub().resolves(initial),
                config: { renewalFraction: 0.1 },
            });

            try {
                await auth.getAuthToken();
                clock.tick(249);
                await flush();
                expect(api.makeRequest).to.not.have.been.called;

                clock.tick(1);
                await flush();
                expect(api.makeRequest.firstCall).to.have.been.calledWith(
                    'POST', '/auth/token/renew-self', null, { 'X-Vault-Token': 'near-expiry' }
                );
            } finally {
                auth.cancelTokenRefresh();
            }
        });

        it('uses the fallback expiry deadline to schedule a short-TTL renewal before expiry', async function () {
            clock.setSystemTime(950);
            const api = apiStub();
            api.makeRequest.onFirstCall().resolves({});
            api.makeRequest.onSecondCall().resolves(lookupResponse({ id: 'renewed', creationTime: 1, ttl: 3600, expireMs: 10000000 }));
            const initial = AuthToken.fromResponse(lookupResponse({ id: 'fallback-short-ttl', ttl: 2 }));
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(initial) });

            try {
                expect(initial.hasPreciseExpiry()).to.equal(false);
                expect(initial.getExpiresAtMilliseconds()).to.equal(2000);
                await auth.getAuthToken();

                clock.tick(524);
                await flush();
                expect(api.makeRequest).to.not.have.been.called;

                clock.tick(1);
                await flush();
                expect(api.makeRequest.firstCall).to.have.been.calledWith(
                    'POST', '/auth/token/renew-self', null, { 'X-Vault-Token': 'fallback-short-ttl' }
                );
                expect(auth.__authToken.getId()).to.equal('renewed');
            } finally {
                auth.cancelTokenRefresh();
            }
        });

        it('rejects an invalid renewalFraction at construction', function () {
            for (const bad of [0, -0.5, 1.5, NaN, Infinity, '0.5', null]) {
                expect(
                    () => new TestAuth(apiStub(), 'mount', { config: { renewalFraction: bad } }),
                    `renewalFraction=${String(bad)} must be rejected`
                ).to.throw(errors.InvalidArgumentsError, 'renewalFraction');
            }
        });

        it('rejects an invalid renewalIncrement at construction', function () {
            for (const bad of [0, -60, 1.5, NaN, '3600', null]) {
                expect(
                    () => new TestAuth(apiStub(), 'mount', { config: { renewalIncrement: bad } }),
                    `renewalIncrement=${String(bad)} must be rejected`
                ).to.throw(errors.InvalidArgumentsError, 'renewalIncrement');
            }
        });

        it('rejects the boundary fraction 1', function () {
            // At exactly 1 the timer fires when the client already treats the token as
            // expired, racing its own re-auth and leaving no time for the renewal request.
            expect(() => new TestAuth(apiStub(), 'mount', { config: { renewalFraction: 1 } }))
                .to.throw(errors.InvalidArgumentsError, 'renewalFraction');
        });

        it('accepts a fraction just under 1', function () {
            expect(() => new TestAuth(apiStub(), 'mount', { config: { renewalFraction: 0.99 } }))
                .to.not.throw();
        });
    });

    describe('zero-TTL expiry after token renewal (#201)', function () {
        let clock;

        function flush(times) {
            let p = Promise.resolve();
            for (let i = 0; i < (times || 8); i++) {
                p = p.then(() => undefined);
            }
            return p;
        }

        beforeEach(function () {
            clock = sinon.useFakeTimers({ now: 1000 });
        });

        afterEach(function () {
            clock.restore();
            sinon.restore();
        });

        it('re-authenticates after lookup-self reports zero TTL at the max-TTL expiry', async function () {
            const api = apiStub();
            api.makeRequest.onFirstCall().resolves({});
            api.makeRequest.onSecondCall().resolves(lookupResponse({ id: 'capped', ttl: 0, expireMs: 53000 }));
            const initial = new AuthToken('initial', 'acc', 0, 101, 0, 0, true);
            const fresh = nonRenewableToken('fresh-login');
            const authStub = sinon.stub();
            authStub.onFirstCall().resolves(initial);
            authStub.onSecondCall().resolves(fresh);
            const auth = new TestAuth(api, 'mount', { authStub });

            try {
                await auth.getAuthToken();
                clock.tick(49999);
                await flush();
                expect(api.makeRequest).to.not.have.been.called;

                clock.tick(1);
                await flush();
                expect(api.makeRequest.firstCall).to.have.been.calledWith(
                    'POST', '/auth/token/renew-self', null, { 'X-Vault-Token': 'initial' }
                );
                expect(api.makeRequest.secondCall).to.have.been.calledWith(
                    'GET', '/auth/token/lookup-self', null, { 'X-Vault-Token': 'initial' }
                );
                const capped = auth.__authToken;
                expect(capped.getId()).to.equal('capped');
                expect(auth.__refreshTimeout).to.equal(null);

                expect(capped.isExpired()).to.equal(true);
                expect(await auth.getAuthToken()).to.equal(fresh);
                expect(authStub).to.have.been.calledTwice;
            } finally {
                auth.cancelTokenRefresh();
            }
        });

        it('continues renewing short-period tokens, including sub-second intervals and whole-second ttl jitter', async function () {
            // The sub-second cases are the ones the old wall-clock rule false-stopped on real
            // Vault (5 of 5 clients): lookup-self truncates ttl, so it flips between neighbouring
            // whole seconds (2 and 3 on a period-3 token), and the expiry moves by under 1 s.
            const cases = [
                { ttl: 2, renewalFraction: 0.5 },
                { ttl: 10, renewalFraction: 0.1 },
                { ttl: 2, renewalFraction: 0.4 },
                { ttl: 3, renewalFraction: 0.3 },
                { ttl: 10, renewalFraction: 0.05 },
                { ttl: 30, renewalFraction: 0.03 },
            ];

            for (const c of cases) {
                clock.setSystemTime(1000);
                const api = apiStub();
                let lookups = 0;
                api.makeRequest.callsFake((method) => {
                    if (method === 'POST') {
                        return Promise.resolve({ auth: { lease_duration: c.ttl, renewable: true }, warnings: null });
                    }
                    lookups++;
                    return Promise.resolve(lookupResponse({
                        id: 'short-lived',
                        accessor: 'short-lived-acc',
                        ttl: lookups % 2 === 0 ? c.ttl : c.ttl - 1,
                        expireMs: Date.now() + c.ttl * 1000 - (lookups % 2 === 0 ? 0 : 7),
                    }));
                });
                const initial = AuthToken.fromResponse(lookupResponse({ id: 'short-lived', accessor: 'short-lived-acc', ttl: c.ttl, expireMs: Date.now() + c.ttl * 1000 }));
                const auth = new TestAuth(api, 'mount', {
                    authStub: sinon.stub().resolves(initial),
                    config: { renewalFraction: c.renewalFraction },
                });
                const log = spyLogger();
                auth._log = log;

                try {
                    await auth.getAuthToken();
                    for (let i = 0; i < 5; i++) {
                        // Fire whatever is armed, however the jitter rounded it.
                        clock.tick(Math.ceil(c.ttl * c.renewalFraction * 1000) + 1);
                        await flush();
                        expect(api.makeRequest.callCount, `ttl ${c.ttl}, fraction ${c.renewalFraction}`).to.equal((i + 1) * 2);
                        expect(auth.__refreshTimeout).to.not.equal(null);
                    }
                    expect(log.warn).to.not.have.been.called;
                } finally {
                    auth.cancelTokenRefresh();
                }
            }
        });

        it('warns once when renewal stops at the maximum TTL or zero TTL, without the token id', async function () {
            const RAW_ID = 'hvs.RAW-RENEWED-TOKEN-ID-NOBODY-MAY-LOG';
            const cases = [
                { renew: cappedRenewResponse(30), ttl: 30, expireMs: 62500, reason: 'capped the renewal' },
                { renew: {}, ttl: 0, expireMs: 32500, reason: 'token already expired' },
            ];

            for (const c of cases) {
                clock.setSystemTime(1000);
                const api = apiStub();
                api.makeRequest.onFirstCall().resolves(c.renew);
                api.makeRequest.onSecondCall().resolves(lookupResponse({
                    id: RAW_ID, accessor: 'capped-acc', ttl: c.ttl, expireMs: c.expireMs,
                }));
                const initial = AuthToken.fromResponse(lookupResponse({
                    id: 'initial', accessor: 'initial-acc', ttl: 61, expireMs: 62000,
                }));
                const auth = new TestAuth(api, 'mount', {
                    authStub: sinon.stub().resolves(initial),
                    reauth: false,
                });
                const log = spyLogger();
                auth._log = log;

                try {
                    await auth.getAuthToken();
                    clock.tick(30500);
                    await flush();

                    expect(auth.__refreshTimeout).to.equal(null);
                    expect(log.warn).to.have.been.calledOnce;
                    const text = loggedText(log);
                    expect(text).to.contain('capped-acc').and.to.contain(c.reason)
                        .and.to.contain('AuthTokenExpiredError');
                    expect(text, 'raw token id must never reach the logger').to.not.contain(RAW_ID);
                } finally {
                    auth.cancelTokenRefresh();
                }
            }
        });

        it('warns and arms nothing for a duck-typed token with no usable expiry', async function () {
            const duck = {
                getId: () => 'duck', getAccessor: () => 'duck-acc',
                isExpired: () => false, isRenewable: () => true, getExpiresAt: () => null,
            };
            const auth = new TestAuth(apiStub(), 'mount', { authStub: sinon.stub().resolves(duck) });
            const log = spyLogger();
            auth._log = log;

            await auth.getAuthToken();

            expect(auth.__refreshTimeout).to.equal(null);
            expect(log.warn).to.have.been.calledOnce;
            expect(loggedText(log)).to.contain('token has no usable expiry').and.to.contain('duck-acc');
        });

        it('warns and arms nothing when under 250 ms of lifetime is left', async function () {
            const initial = AuthToken.fromResponse(lookupResponse({ id: 'nearly-gone', ttl: 1, expireMs: 1200 }));
            const auth = new TestAuth(apiStub(), 'mount', { authStub: sinon.stub().resolves(initial) });
            const log = spyLogger();
            auth._log = log;

            await auth.getAuthToken();

            expect(auth.__refreshTimeout).to.equal(null);
            expect(log.warn).to.have.been.calledOnce;
            expect(loggedText(log)).to.contain('too little lifetime left to renew');
        });

        it('logs "renewal timer armed" only when a timer is actually armed', async function () {
            const expired = AuthToken.fromResponse(lookupResponse({ id: 'gone', ttl: 0, expireMs: 500 }));
            const live = AuthToken.fromResponse(lookupResponse({ id: 'live', ttl: 3600, expireMs: 3601000 }));
            for (const [token, armed] of [[expired, false], [live, true]]) {
                const auth = new TestAuth(apiStub(), 'mount', { authStub: sinon.stub().resolves(token) });
                const log = spyLogger();
                auth._log = log;
                try {
                    await auth.getAuthToken();
                    expect(loggedText(log).includes('renewal timer armed'), token.getId()).to.equal(armed);
                    expect(auth.__refreshTimeout !== null, token.getId()).to.equal(armed);
                } finally {
                    auth.cancelTokenRefresh();
                }
            }
        });

        it('does not reject a login when the stop warning names an expiry Date cannot represent', async function () {
            const duck = {
                getId: () => 'duck', getAccessor: () => 'duck-acc',
                isExpired: () => true, isRenewable: () => true, getExpiresAt: () => 1e300,
            };
            const auth = new TestAuth(apiStub(), 'mount', { authStub: sinon.stub().resolves(duck) });
            const log = spyLogger();
            auth._log = log;

            expect(await auth.getAuthToken()).to.equal(duck);
            expect(loggedText(log)).to.contain('token already expired').and.to.contain('1e+303');
        });

        for (const errorThrowsToo of [false, true]) {
            it(`keeps the renewed token and re-arms nothing stale when the stop warning throws${errorThrowsToo ? ' (and so does error)' : ''}`, async function () {
                clock.setSystemTime(1000);
                const api = apiStub();
                api.makeRequest.onFirstCall().resolves(cappedRenewResponse(30));
                api.makeRequest.onSecondCall().resolves(lookupResponse({ id: 'renewed', ttl: 30, expireMs: 62500 }));
                const initial = AuthToken.fromResponse(lookupResponse({ id: 'initial', ttl: 61, expireMs: 62000 }));
                const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(initial) });
                const log = spyLogger();
                log.warn = sinon.stub().throws(new Error('logger sink closed'));
                if (errorThrowsToo) {
                    log.error = sinon.stub().throws(new Error('logger sink closed'));
                }
                auth._log = log;
                const unhandled = sinon.spy();
                process.on('unhandledRejection', unhandled);

                try {
                    await auth.getAuthToken();
                    clock.tick(30500);
                    await flush(16);

                    expect(auth.__authToken.getId(), 'the renewed token stays adopted').to.equal('renewed');
                    expect(auth.__refreshTimeout, 'no timer re-armed against the old token').to.equal(null);
                    expect(loggedText(log)).to.contain('token renewal bookkeeping failed')
                        .and.to.not.contain('Cannot refresh auth token');
                    expect(unhandled).to.not.have.been.called;
                } finally {
                    process.removeListener('unhandledRejection', unhandled);
                    auth.cancelTokenRefresh();
                }
            });
        }

        it('does not warn when renewal is disabled', async function () {
            const auth = new TestAuth(apiStub(), 'mount', {
                config: { renewal: false },
                authStub: sinon.stub().resolves(nonRenewableToken()),
            });
            const log = spyLogger();
            auth._log = log;

            await auth.getAuthToken();

            expect(auth.__refreshTimeout).to.equal(null);
            expect(log.warn).to.not.have.been.called;
        });

        it('raises AuthTokenExpiredError for token auth after a zero-TTL max-TTL expiry', async function () {
            const api = apiStub();
            api.makeRequest.onFirstCall().resolves({});
            api.makeRequest.onSecondCall().resolves(lookupResponse({ id: 'capped', ttl: 0, expireMs: 53000 }));
            const authStub = sinon.stub().resolves(new AuthToken('initial', 'acc', 0, 101, 0, 0, true));
            const auth = new TestAuth(api, 'mount', { authStub, reauth: false });

            try {
                await auth.getAuthToken();
                clock.tick(50000);
                await flush();
                expect(auth.__authToken.getId()).to.equal('capped');
                expect(api.makeRequest).to.have.been.calledTwice;

                clock.tick(1000);
                await auth.getAuthToken().then(
                    () => { throw new Error('expected rejection'); },
                    (err) => expect(err).to.be.instanceOf(errors.AuthTokenExpiredError)
                );
                expect(authStub).to.have.been.calledOnce;
            } finally {
                auth.cancelTokenRefresh();
            }
        });
    });

    describe('superseded renewal callbacks (#145)', function () {
        let clock;

        function flush(times) {
            let p = Promise.resolve();
            for (let i = 0; i < (times || 8); i++) {
                p = p.then(() => undefined);
            }
            return p;
        }

        function deferred() {
            let settle;
            const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
            return { promise, ...settle };
        }

        /** Token A: renewable, expires at 100s, so its timer fires at 50s on a clock at 0. */
        function tokenA() {
            return new AuthToken('A', 'accA', 0, 100, 0, 0, true);
        }

        function tokenB() {
            return new AuthToken('B', 'accB', 0, 1000, 0, 0, true);
        }

        /** Arms A's timer, fires it, and leaves the renew request hanging. */
        async function renewalInFlight() {
            const api = apiStub();
            const renewCall = deferred();
            api.makeRequest.returns(renewCall.promise);
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(tokenA()) });
            sinon.stub(auth, '_getTokenEntity').resolves(new AuthToken('A-renewed', 'accA', 0, 200, 0, 0, true));

            await auth.getAuthToken();
            clock.tick(50000);
            await flush();
            expect(api.makeRequest, 'the renewal should be in flight').to.have.been.called;
            return { auth, renewCall };
        }

        beforeEach(function () {
            clock = sinon.useFakeTimers();
        });

        afterEach(function () {
            clock.restore();
            sinon.restore();
        });

        it('a stale renewal that succeeds does not overwrite the newer token', async function () {
            const { auth, renewCall } = await renewalInFlight();

            const b = tokenB();
            auth.__authToken = b;
            auth.__setupTokenRefreshTimer(b);

            renewCall.resolve({});
            await flush();

            expect(auth.__authToken, 'the newer token must survive').to.equal(b);
        });

        it('a stale renewal that fails does not clear the newer token timer', async function () {
            const { auth, renewCall } = await renewalInFlight();

            const b = tokenB();
            auth.__authToken = b;
            auth.__setupTokenRefreshTimer(b);
            const bTimer = auth.__refreshTimeout;

            renewCall.reject(new Error('vault unreachable'));
            await flush();

            expect(auth.__refreshTimeout, "the newer token's timer must stay armed").to.equal(bTimer);
            expect(auth.__refreshTimeout).to.not.equal(null);
        });

        it('a renewal in flight when cancelTokenRefresh() runs does not re-arm', async function () {
            const { auth, renewCall } = await renewalInFlight();

            auth.cancelTokenRefresh();
            expect(auth.__refreshTimeout).to.equal(null);

            renewCall.resolve({});
            await flush();

            expect(auth.__refreshTimeout, 'close() must not be undone by an in-flight renewal').to.equal(null);
        });

        it('a failing renewal in flight when cancelTokenRefresh() runs does not re-arm', async function () {
            const { auth, renewCall } = await renewalInFlight();

            auth.cancelTokenRefresh();
            renewCall.reject(new Error('vault unreachable'));
            await flush();

            expect(auth.__refreshTimeout).to.equal(null);
        });

        it('an undisturbed renewal still applies and re-arms', async function () {
            const { auth, renewCall } = await renewalInFlight();

            renewCall.resolve({});
            await flush();

            expect(auth.__authToken.getId(), 'the renewed token should be adopted').to.equal('A-renewed');
            expect(auth.__refreshTimeout, 'and a new timer armed').to.not.equal(null);
            auth.cancelTokenRefresh();
        });
    });

    describe('token refresh timer', function () {
        let clock;

        function flush(times) {
            let p = Promise.resolve();
            for (let i = 0; i < (times || 8); i++) {
                p = p.then(() => undefined);
            }
            return p;
        }

        beforeEach(function () {
            clock = sinon.useFakeTimers();
        });

        afterEach(function () {
            clock.restore();
        });

        it('schedules and performs a renewal for a renewable token', function () {
            const renewable = new AuthToken('rid', 'racc', 0, 100, 0, 0, true);
            const renewed = nonRenewableToken('rid2');
            const api = apiStub();
            api.makeRequest.resolves({});
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(renewable) });
            sinon.stub(auth, '_getTokenEntity').resolves(renewed);

            return auth.getAuthToken()
                .then(() => {
                    expect(api.makeRequest).to.not.have.been.called;
                    clock.tick(50000);
                    return flush();
                })
                .then(() => {
                    expect(api.makeRequest).to.have.been.calledWith('POST', '/auth/token/renew-self', null, { 'X-Vault-Token': 'rid' });
                    expect(auth._getTokenEntity).to.have.been.calledWith('rid');
                });
        });

        it('cancelTokenRefresh() clears the armed timer so no further renewal fires', function () {
            const renewable = new AuthToken('rid', 'racc', 0, 100, 0, 0, true);
            const api = apiStub();
            api.makeRequest.resolves({});
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(renewable) });
            sinon.stub(auth, '_getTokenEntity').resolves(nonRenewableToken('rid2'));

            return auth.getAuthToken()
                .then(() => {
                    expect(auth.__refreshTimeout).to.not.equal(null);
                    auth.cancelTokenRefresh();
                    expect(auth.__refreshTimeout).to.equal(null);
                    // Advancing well past the original renewal point must not trigger a renewal.
                    clock.tick(200000);
                    return flush();
                })
                .then(() => {
                    expect(api.makeRequest).to.not.have.been.called;
                });
        });

        it('cancelTokenRefresh() is a no-op when no timer is armed and is safe to call twice', function () {
            const auth = new TestAuth(apiStub(), 'mount');
            expect(auth.__refreshTimeout).to.equal(null);
            expect(() => { auth.cancelTokenRefresh(); auth.cancelTokenRefresh(); }).to.not.throw();
            expect(auth.__refreshTimeout).to.equal(null);
        });

        it('logs the accessor, never the raw token id, when arming the refresh timer (regression #104)', function () {
            const RAW_ID = 's.RAWBASETOKENSHOULDNEVERBELOGGED';
            const ACCESSOR = 'base-accessor-1234';
            const renewable = new AuthToken(RAW_ID, ACCESSOR, 0, 100, 0, 0, true);
            const api = apiStub();
            api.makeRequest.resolves({});
            const log = spyLogger();
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(renewable) });
            auth._log = log;
            sinon.stub(auth, '_getTokenEntity').resolves(nonRenewableToken('rid2'));

            return auth.getAuthToken().then(() => {
                auth.cancelTokenRefresh();
                expect(loggedText(log), 'raw token id must never reach the logger').to.not.contain(RAW_ID);
                // The non-sensitive accessor is logged instead, so the debug line stays useful.
                expect(loggedText(log)).to.contain(ACCESSOR);
            });
        });

        it('logs and reschedules when a renewal fails', function () {
            const renewable = new AuthToken('rid', 'racc', 0, 100, 0, 0, true);
            const api = apiStub();
            api.makeRequest.rejects(new Error('renew failed'));
            const errorSpy = sinon.spy();
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(renewable) });
            auth._log = _.assign({}, logger, { error: errorSpy });

            let renewalsAfterFirstFailure;

            return auth.getAuthToken()
                .then(() => {
                    clock.tick(50000);
                    return flush();
                })
                .then(() => {
                    expect(api.makeRequest).to.have.been.calledWith('POST', '/auth/token/renew-self');
                    expect(errorSpy).to.have.been.called;
                    // The timer must actually re-arm after the failure ...
                    expect(auth.__refreshTimeout).to.not.equal(null);
                    renewalsAfterFirstFailure = api.makeRequest.callCount;
                    clock.tick(50000);
                    return flush();
                })
                .then(() => {
                    // ... so advancing the clock again triggers another renewal attempt.
                    expect(api.makeRequest.callCount).to.be.greaterThan(renewalsAfterFirstFailure);
                });
        });
    });
});
