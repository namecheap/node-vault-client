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
