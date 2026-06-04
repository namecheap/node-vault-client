'use strict';

const _ = require('lodash');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const VaultApiClient = require('../src/VaultApiClient');
const VaultBaseAuth = require('../src/auth/VaultBaseAuth');
const AuthToken = require('../src/auth/AuthToken');

const logger = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (p) => [p, _.noop]));

function apiStub() {
    return sinon.createStubInstance(VaultApiClient);
}

const nowSec = () => Math.floor(Date.now() / 1000);

// Minimal concrete subclass so we can drive the abstract base class behaviour.
class TestAuth extends VaultBaseAuth {
    constructor(api, mount, opts) {
        super(api, logger, mount);
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

describe('VaultBaseAuth', function () {
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

        // Documents current behaviour: when reauth is disallowed (e.g. token auth) an
        // expired token is returned as-is. The AuthTokenExpiredError branch in the
        // source is in fact unreachable given a deterministic _reauthenticationAllowed().
        it('returns the expired token without re-authenticating when reauth is disallowed', function () {
            const expired = new AuthToken('old', 'acc', 0, nowSec() - 100, 0, 0, false);
            const authStub = sinon.stub().resolves(expired);
            const auth = new TestAuth(apiStub(), 'mount', { authStub, reauth: false });

            return auth.getAuthToken()
                .then((t1) => {
                    expect(t1).to.equal(expired);
                    return auth.getAuthToken();
                })
                .then((t2) => {
                    expect(t2).to.equal(expired);
                    expect(authStub).to.have.been.calledOnce;
                });
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
            // fake "now" == 0; expiresAt == 100s => timer == ((100-0)/2)*1000 == 50000ms
            const renewable = new AuthToken('rid', 'racc', 0, 100, 0, 0, true);
            const renewed = nonRenewableToken('rid2'); // non-renewable so the loop stops
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

        it('logs and reschedules when a renewal fails', function () {
            const renewable = new AuthToken('rid', 'racc', 0, 100, 0, 0, true);
            const api = apiStub();
            api.makeRequest.rejects(new Error('renew failed'));
            const errorSpy = sinon.spy();
            const auth = new TestAuth(api, 'mount', { authStub: sinon.stub().resolves(renewable) });
            auth._log = _.assign({}, logger, { error: errorSpy });

            return auth.getAuthToken()
                .then(() => {
                    clock.tick(50000);
                    return flush();
                })
                .then(() => {
                    expect(api.makeRequest).to.have.been.calledWith('POST', '/auth/token/renew-self');
                    expect(errorSpy).to.have.been.called;
                });
        });
    });
});
