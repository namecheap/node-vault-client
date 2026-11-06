/**
 * close() while a login is in flight: the login still resolves and its token is cached, but it
 * arms no refresh timer. Before the fix the login armed one after close() returned, so a
 * short-lived script that closed its client never exited.
 */
import http from 'node:http';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultBaseAuth from '../src/auth/VaultBaseAuth.js';
import AuthToken from '../src/auth/AuthToken.js';
import errors from '../src/errors.js';
import { createNoopLogger, createSpyLogger } from './helpers/logger.mjs';

use(sinonChai);

const nowSec = () => Math.floor(Date.now() / 1000);

function renewableToken(id = 'renewable-id', lifetimeSec = 3600) {
    return new AuthToken(id, `acc-${id}`, nowSec(), nowSec() + lifetimeSec, 0, 0, true, null, lifetimeSec);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** A login that waits until the test settles it. */
class HeldAuth extends VaultBaseAuth {
    constructor(api, logger, config) {
        super(api, logger || createNoopLogger(), 'mount');
        if (config !== undefined) {
            this.configureRenewal(config);
        }
        this.logins = [];
    }

    _authenticate() {
        const login = deferred();
        this.logins.push(login);
        return login.promise;
    }
}

describe('close() while a login is in flight', function () {
    const created = [];

    function makeAuth(logger, config) {
        const auth = new HeldAuth(sinon.createStubInstance(VaultApiClient), logger, config);
        created.push(auth);
        return auth;
    }

    afterEach(function () {
        // test:unit runs without --exit: a timer left armed by a failed assertion would hang it.
        created.splice(0).forEach((auth) => auth.cancelTokenRefresh());
        sinon.restore();
    });

    describe('VaultBaseAuth', function () {
        it('resolves the login and caches its token, but arms no refresh timer', async function () {
            const auth = makeAuth();
            const pending = auth.getAuthToken();
            auth.cancelTokenRefresh();
            auth.logins[0].resolve(renewableToken());

            const token = await pending;

            expect(token.getId()).to.equal('renewable-id');
            expect(auth.__refreshTimeout, 'no timer after close()').to.equal(null);
            expect(await auth.getAuthToken(), 'the token stays cached').to.equal(token);
            expect(auth.logins).to.have.length(1);
        });

        it('gives every caller sharing the login the token, still without a timer', async function () {
            const auth = makeAuth();
            const first = auth.getAuthToken();
            const second = auth.getAuthToken();
            auth.cancelTokenRefresh();
            const third = auth.getAuthToken();
            auth.logins[0].resolve(renewableToken());

            const tokens = await Promise.all([first, second, third]);

            expect(auth.logins).to.have.length(1);
            expect(tokens.map((t) => t.getId())).to.deep.equal(['renewable-id', 'renewable-id', 'renewable-id']);
            expect(auth.__refreshTimeout).to.equal(null);
        });

        it('still arms a timer for a login that starts after close() (unchanged)', async function () {
            const auth = makeAuth();
            auth.cancelTokenRefresh();
            const pending = auth.getAuthToken();
            auth.logins[0].resolve(renewableToken());

            await pending;

            expect(auth.__refreshTimeout, 'a later login renews as before').to.not.equal(null);
        });

        it('arms a timer again for the next login once the closed one\'s token has expired', async function () {
            const auth = makeAuth();
            const pending = auth.getAuthToken();
            auth.cancelTokenRefresh();
            // Expired on arrival, so the next getAuthToken() logs in again.
            auth.logins[0].resolve(new AuthToken('old', 'acc-old', nowSec() - 7200, nowSec() - 3600, 0, 0, true));
            await pending;
            expect(auth.__refreshTimeout).to.equal(null);

            const next = auth.getAuthToken();
            auth.logins[1].resolve(renewableToken('new'));

            expect((await next).getId()).to.equal('new');
            expect(auth.__refreshTimeout, 'close() does not stick to later logins').to.not.equal(null);
        });

        it('rejects a failed login as before, and the retry arms a timer', async function () {
            const auth = makeAuth();
            const pending = auth.getAuthToken();
            auth.cancelTokenRefresh();
            const failure = new errors.VaultHttpError(500, 'login failed', {});
            auth.logins[0].reject(failure);

            const outcome = await pending.then(() => null, (err) => err);
            expect(outcome).to.equal(failure);

            const retry = auth.getAuthToken();
            auth.logins[1].resolve(renewableToken());
            await retry;
            expect(auth.__refreshTimeout).to.not.equal(null);
        });

        it('logs why no timer was armed, without the token id', async function () {
            const logger = createSpyLogger();
            const auth = makeAuth(logger);
            const pending = auth.getAuthToken();
            auth.cancelTokenRefresh();
            auth.logins[0].resolve(renewableToken('secret-token-id'));
            await pending;

            expect(logger.debug).to.have.been.calledWith(
                'client closed during login; not arming a refresh timer (accessor=%s)', 'acc-secret-token-id');
            for (const call of logger.debug.getCalls().concat(logger.warn.getCalls())) {
                expect(call.args).not.to.include('secret-token-id');
            }
            expect(logger.warn, 'nothing to warn about').not.to.have.been.called;
        });

        it('logs nothing extra for a token that would not have been renewed anyway', async function () {
            const logger = createSpyLogger();
            const auth = makeAuth(logger);
            const pending = auth.getAuthToken();
            auth.cancelTokenRefresh();
            auth.logins[0].resolve(new AuthToken('static', 'acc', 0, null, 0, 0, false));
            await pending;

            const closedLine = logger.debug.getCalls()
                .filter((c) => String(c.args[0]).startsWith('client closed during login'));
            expect(closedLine).to.have.length(0);
        });

        it('keeps the "renewal disabled" debug line when renewal: false', async function () {
            const logger = createSpyLogger();
            const auth = makeAuth(logger, { renewal: false });
            const pending = auth.getAuthToken();
            auth.cancelTokenRefresh();
            auth.logins[0].resolve(renewableToken());
            await pending;

            expect(logger.debug).to.have.been.calledWith(
                'renewal disabled by config; not arming a refresh timer (accessor=%s)', 'acc-renewable-id');
            const closedLine = logger.debug.getCalls()
                .filter((c) => String(c.args[0]).startsWith('client closed during login'));
            expect(closedLine).to.have.length(0);
            expect(auth.__refreshTimeout).to.equal(null);
        });

        it('keeps the "renewal stopped" warning for a renewable token with no usable expiry (#236)', async function () {
            const logger = createSpyLogger();
            const auth = makeAuth(logger);
            const pending = auth.getAuthToken();
            auth.cancelTokenRefresh();
            const token = new AuthToken('no-expiry', 'acc-no-expiry', 0, null, 0, 0, true);
            token.__renewableWithoutExpiry = true;
            auth.logins[0].resolve(token);
            await pending;

            expect(logger.warn).to.have.been.calledOnce;
            expect(logger.warn.firstCall.args[0]).to.match(/^token renewal stopped \(accessor=%s\)/);
            expect(auth.__refreshTimeout).to.equal(null);
        });

        it('gives a call that joins the closed login after close() its token, without a timer', async function () {
            const auth = makeAuth();
            const before = auth.getAuthToken();
            auth.cancelTokenRefresh();
            const joined = auth.getAuthToken();
            auth.logins[0].resolve(renewableToken());

            expect(await joined).to.equal(await before);
            expect(auth.logins, 'the joined call starts no login of its own').to.have.length(1);
            expect(auth.__refreshTimeout).to.equal(null);
        });

        it('does not fail the login when the logger throws', async function () {
            const logger = createNoopLogger();
            logger.debug = () => {
                throw new Error('logger down');
            };
            const auth = makeAuth(logger);
            const pending = auth.getAuthToken();
            auth.cancelTokenRefresh();
            auth.logins[0].resolve(renewableToken());

            expect((await pending).getId()).to.equal('renewable-id');
            expect(auth.__refreshTimeout).to.equal(null);
        });

        it('a token dropped after a 403 during a login does not count as close()', async function () {
            // A cached token A gets a 403; its lookup-self is still out when A expires locally
            // and a new login starts. The lookup then says A is dead and stops A's renewal. That
            // is not a close(): the new login's token must still get a refresh timer.
            const api = sinon.createStubInstance(VaultApiClient);
            const lookup = deferred();
            api.makeRequest.returns(lookup.promise);
            const auth = new HeldAuth(api);
            created.push(auth);

            const first = auth.getAuthToken();
            auth.logins[0].resolve(renewableToken('tok-a', 3600));
            const tokenA = await first;
            const check = auth.checkRejectedToken(tokenA);

            // A expires locally while the check is out.
            sinon.stub(tokenA, 'isExpired').returns(true);
            const second = auth.getAuthToken();
            lookup.reject(new errors.VaultHttpError(403, 'permission denied', {}));
            expect(await check, 'A is dead').to.equal(true);

            auth.logins[1].resolve(renewableToken('tok-b'));
            expect((await second).getId()).to.equal('tok-b');
            expect(auth.__refreshTimeout, 'B is renewed').to.not.equal(null);
        });
    });

    describe('a subclass that overrides cancelTokenRefresh()', function () {
        it('without calling super still arms no timer when VaultClient#close() runs mid-login', async function () {
            const client = new VaultClient({
                api: { url: 'http://127.0.0.1:1' },
                logger: createNoopLogger(),
                auth: { type: 'token', config: { token: 't' } },
            });
            const auth = new HeldAuth(sinon.createStubInstance(VaultApiClient));
            created.push(auth);
            auth.cancelTokenRefresh = function () { /* the subclass's own cleanup, no super */ };
            client.__auth = auth;

            const pending = auth.getAuthToken();
            client.close();
            auth.logins[0].resolve(renewableToken());
            await pending;

            expect(auth.__refreshTimeout).to.equal(null);
        });

        it('still hears about a token dropped after a 403, which does not count as close()', async function () {
            const api = sinon.createStubInstance(VaultApiClient);
            api.makeRequest.rejects(new errors.VaultHttpError(403, 'permission denied', {}));
            const auth = new HeldAuth(api);
            created.push(auth);
            const override = sinon.spy(auth, 'cancelTokenRefresh');

            const first = auth.getAuthToken();
            auth.logins[0].resolve(renewableToken('tok-a'));
            expect(await auth.checkRejectedToken(await first)).to.equal(true);
            expect(override, 'the override runs, as before').to.have.been.calledOnce;

            const second = auth.getAuthToken();
            auth.logins[1].resolve(renewableToken('tok-b'));
            await second;
            expect(auth.__refreshTimeout, 'the next token is renewed').to.not.equal(null);
        });
    });

    describe('VaultClient#close()', function () {
        let server;
        let url;
        let heldLogin;
        let loginArrived;
        let logins;
        let client;

        before(function (done) {
            server = http.createServer((req, res) => {
                req.resume();
                req.on('end', () => {
                    const reply = (status, payload) => {
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(payload));
                    };
                    if (req.url === '/v1/auth/approle/login') {
                        logins++;
                        loginArrived.resolve();
                        const answer = () => reply(200, {
                            auth: { client_token: 'tok-1', accessor: 'acc-1', renewable: true, lease_duration: 3600 },
                        });
                        return heldLogin ? heldLogin.promise.then(answer) : answer();
                    }
                    if (req.url === '/v1/auth/token/lookup-self') {
                        return reply(200, {
                            data: {
                                id: 'tok-1', accessor: 'acc-1', ttl: 3600, renewable: true,
                                expire_time: new Date(Date.now() + 3600000).toISOString(),
                            },
                        });
                    }
                    if (req.url === '/v1/secret/a') {
                        return reply(200, { data: { value: 'v' } });
                    }
                    return reply(404, { errors: [] });
                });
            });
            server.listen(0, '127.0.0.1', () => {
                url = `http://127.0.0.1:${server.address().port}`;
                done();
            });
        });

        after(function () {
            server.closeAllConnections();
            server.close();
        });

        beforeEach(function () {
            heldLogin = deferred();
            loginArrived = deferred();
            logins = 0;
            client = new VaultClient({
                api: { url },
                logger: createNoopLogger(),
                auth: { type: 'appRole', config: { role_id: 'r', secret_id: 's' } },
            });
        });

        afterEach(function () {
            client.close();
            heldLogin.resolve();
        });

        it('a read in flight still resolves, and no refresh timer is left armed', async function () {
            const read = client.read('secret/a');
            await loginArrived.promise;
            client.close();
            heldLogin.resolve();

            const lease = await read;

            expect(lease.getValue('value')).to.equal('v');
            expect(client.__auth.__refreshTimeout, 'close() releases the event loop').to.equal(null);
        });

        it('the closed client stays usable on the cached token', async function () {
            const read = client.read('secret/a');
            await loginArrived.promise;
            client.close();
            heldLogin.resolve();
            await read;

            const again = await client.read('secret/a');

            expect(again.getValue('value')).to.equal('v');
            expect(logins).to.equal(1);
            expect(client.__auth.__refreshTimeout).to.equal(null);
        });

        it('a client that is not closed still arms its timer (unchanged)', async function () {
            heldLogin.resolve();
            await client.read('secret/a');
            expect(client.__auth.__refreshTimeout).to.not.equal(null);
        });
    });
});
