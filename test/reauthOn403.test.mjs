/**
 * Re-authentication on a 403 (issue #235): when Vault rejects the cached token on an
 * authenticated request because it no longer accepts it (revoked server-side), the client
 * drops it, logs in again and sends the request once more. A policy denial, a 403 on the login
 * itself and a 403 under `token` auth surface as before.
 */
import http from 'node:http';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import errors from '../src/errors.js';
import { createSpyLogger, loggedText } from './helpers/logger.mjs';

use(sinonChai);

function settle(promise) {
    return promise.then((value) => ({ value }), (error) => ({ error }));
}

const DENIED = { errors: ['1 error occurred:\n\t* permission denied\n\n'] };
const INVALID = { errors: ['2 errors occurred:\n\t* permission denied\n\t* invalid token\n\n'] };

/**
 * A Vault double: AppRole logins issue tok-1, tok-2, …; a token is accepted until revoked.
 * `secret/denied` is refused by policy to every token.
 */
function fakeVault() {
    const state = {
        issued: 0,
        revoked: new Set(),
        log: [],
        renewable: false,
        // Overrides, set per test.
        login: null,
        lookup: null,
        secret: null,
    };

    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const token = req.headers['x-vault-token'];
            const path = req.url;
            state.log.push({ method: req.method, path, token, body });
            const reply = (status, payload) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            };
            const alive = token !== undefined && !state.revoked.has(token);

            if (path === '/v1/auth/approle/login') {
                if (state.login) {
                    return state.login(reply);
                }
                const id = `tok-${++state.issued}`;
                return reply(200, { auth: { client_token: id, accessor: `acc-${state.issued}`, renewable: state.renewable } });
            }
            if (path === '/v1/auth/token/lookup-self') {
                if (state.lookup && state.lookup(reply, token)) {
                    return undefined;
                }
                if (!alive) {
                    return reply(403, INVALID);
                }
                return reply(200, {
                    data: {
                        id: token,
                        accessor: token === 'static-tok' ? 'acc-static' : token.replace('tok', 'acc'),
                        ttl: 3600,
                        expire_time: new Date(Date.now() + 3600000).toISOString(),
                        renewable: state.renewable,
                    },
                });
            }
            if (path.startsWith('/v1/sys/internal/ui/mounts/')) {
                if (alive && path.includes('/denied')) {
                    return reply(403, DENIED);
                }
                return alive
                    ? reply(200, { data: { path: 'secret/', type: 'kv', options: { version: '1' } } })
                    : reply(403, INVALID);
            }
            if (path.startsWith('/v1/secret/')) {
                if (state.secret && state.secret(reply, token)) {
                    return undefined;
                }
                if (!alive) {
                    return reply(403, INVALID);
                }
                if (path === '/v1/secret/denied') {
                    return reply(403, DENIED);
                }
                if (path === '/v1/secret/missing') {
                    return reply(404, { errors: [] });
                }
                return reply(200, { data: { path, method: req.method, body, token } });
            }
            return reply(404, { errors: [] });
        });
    });

    const count = (method, path, token) => state.log
        .filter((r) => r.method === method && r.path === path && (token === undefined || r.token === token)).length;

    return { server, state, count };
}

describe('re-authentication on a 403 (#235)', function () {
    let vault;
    let url;
    let client;
    let logger;

    before(function (done) {
        vault = fakeVault();
        vault.server.listen(0, '127.0.0.1', () => {
            url = `http://127.0.0.1:${vault.server.address().port}`;
            done();
        });
    });

    after(function () {
        vault.server.closeAllConnections();
        vault.server.close();
    });

    beforeEach(function () {
        Object.assign(vault.state, {
            issued: 0, revoked: new Set(), log: [], renewable: false, login: null, lookup: null, secret: null,
        });
        logger = createSpyLogger();
    });

    afterEach(function () {
        if (client) {
            client.close();
            client = null;
        }
        sinon.restore();
    });

    const appRoleClient = (extra = {}) => {
        client = new VaultClient(Object.assign({
            api: { url },
            logger,
            auth: { type: 'appRole', config: { role_id: 'r', secret_id: 's' } },
        }, extra));
        return client;
    };
    const logins = () => vault.count('POST', '/v1/auth/approle/login');
    const lookups = (token) => vault.count('GET', '/v1/auth/token/lookup-self', token);

    it('logs in again and sends the request once more when Vault no longer accepts the token', async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');

        const lease = await client.read('secret/a');

        expect(lease.getData().token).to.equal('tok-2');
        expect(logins()).to.equal(2);
        expect(vault.count('GET', '/v1/secret/a', 'tok-1')).to.equal(2);
        expect(vault.count('GET', '/v1/secret/a', 'tok-2')).to.equal(1);
        expect(logger.warn).to.have.been.calledWith(
            'Vault no longer accepts the token (accessor=%s); logging in again', 'acc-1');
        expect(loggedText(logger)).not.to.include('tok-1');
    });

    it('keeps using the new token afterwards', async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');
        await client.read('secret/a');

        await client.read('secret/b');

        expect(logins()).to.equal(2);
        expect(vault.count('GET', '/v1/secret/b', 'tok-2')).to.equal(1);
        expect(vault.count('GET', '/v1/secret/b', 'tok-1')).to.equal(0);
    });

    it('surfaces a policy denial as before, after one lookup-self and without logging in again', async function () {
        appRoleClient();

        const { error } = await settle(client.read('secret/denied'));

        expect(error).to.be.instanceOf(errors.VaultHttpError);
        expect(error.statusCode).to.equal(403);
        expect(error.error).to.deep.equal(DENIED);
        expect(logins()).to.equal(1);
        // One from the login, one to tell the denial from a dead token.
        expect(lookups('tok-1')).to.equal(2);
        expect(vault.count('GET', '/v1/secret/denied')).to.equal(1);
        expect(logger.warn).not.to.have.been.called;
    });

    it('surfaces a 403 on the login itself once, without a lookup-self or a retry', async function () {
        vault.state.login = (reply) => reply(403, DENIED);
        appRoleClient();

        const { error } = await settle(client.read('secret/a'));

        expect(error).to.be.instanceOf(errors.VaultHttpError);
        expect(error.statusCode).to.equal(403);
        expect(logins()).to.equal(1);
        expect(lookups()).to.equal(0);
    });

    it('under token auth, surfaces the 403 with no lookup-self and no re-authentication', async function () {
        client = new VaultClient({
            api: { url }, logger, auth: { type: 'token', renewal: false, config: { token: 'static-tok' } },
        });
        await client.read('secret/a');
        vault.state.revoked.add('static-tok');

        const { error } = await settle(client.read('secret/a'));

        expect(error).to.be.instanceOf(errors.VaultHttpError);
        expect(error.statusCode).to.equal(403);
        expect(lookups('static-tok')).to.equal(1);
        expect(vault.count('GET', '/v1/secret/a')).to.equal(2);
    });

    it('retries only once: a request rejected again after the new login gets that 403', async function () {
        // Every token is accepted by the login's own lookup-self and rejected after that.
        const looked = new Map();
        vault.state.lookup = (reply, token) => {
            const n = (looked.get(token) || 0) + 1;
            looked.set(token, n);
            if (n > 1) {
                reply(403, INVALID);
                return true;
            }
            return false;
        };
        vault.state.secret = (reply) => {
            reply(403, INVALID);
            return true;
        };
        appRoleClient();

        const { error } = await settle(client.read('secret/a'));

        expect(error).to.be.instanceOf(errors.VaultHttpError);
        expect(error.statusCode).to.equal(403);
        expect(logins()).to.equal(2);
        expect(vault.count('GET', '/v1/secret/a')).to.equal(2);
        expect(lookups('tok-2')).to.equal(1);
    });

    it('returns the login error when the new login fails', async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');
        vault.state.login = (reply) => reply(400, { errors: ['invalid role or secret ID'] });

        const { error } = await settle(client.read('secret/a'));

        expect(error).to.be.instanceOf(errors.VaultHttpError);
        expect(error.statusCode).to.equal(400);
        expect(error.message).to.include('invalid role or secret ID');
        expect(logins()).to.equal(2);
    });

    it('returns what the retry got, such as a 404, rather than the dead token\'s 403', async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');

        const { error } = await settle(client.read('secret/missing'));

        expect(error).to.be.instanceOf(errors.VaultHttpError);
        expect(error.statusCode).to.equal(404);
        expect(vault.count('GET', '/v1/secret/missing', 'tok-2')).to.equal(1);
    });

    it('drops the dead token even when the logger throws', async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');
        logger.warn = sinon.stub().throws(new Error('logger broke'));

        const lease = await client.read('secret/a');

        expect(lease.getData().token).to.equal('tok-2');
        expect(logger.warn).to.have.been.calledOnce;
    });

    it('leaves a newer token alone when the lookup for the old one lands after it', async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');
        let answerLookup;
        vault.state.lookup = (reply, token) => {
            if (token !== 'tok-1') {
                return false;
            }
            answerLookup = () => reply(403, INVALID);
            return true;
        };

        const pending = settle(client.read('secret/a'));
        while (!answerLookup) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // Meanwhile another login replaces the token.
        client.__auth.__authToken = null;
        const newer = await client.__auth.getAuthToken();
        answerLookup();
        const { value } = await pending;

        expect(newer.getId()).to.equal('tok-2');
        expect(value.getData().token).to.equal('tok-2');
        expect(client.__auth.__authToken).to.equal(newer);
        expect(logins()).to.equal(2);
    });

    [
        ['the request was in flight', 'secret'],
        ['the lookup was in flight', 'lookup'],
    ].forEach(([label, held]) => it(`drops a dead token that a renewal replaced with a copy while ${label}`, async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');
        let answer;
        vault.state[held] = (reply, token) => {
            if (token !== 'tok-1' || answer) {
                return false;
            }
            answer = () => reply(403, INVALID);
            return true;
        };

        const pending = settle(client.read('secret/a'));
        while (!answer) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // A renewal adopts a new AuthToken object for the same token id.
        const current = client.__auth.__authToken;
        client.__auth.__authToken = Object.assign(Object.create(Object.getPrototypeOf(current)), current);
        answer();
        const { value } = await pending;

        expect(value.getData().token).to.equal('tok-2');
        expect(logins()).to.equal(2);
    }));

    it('leaves a duck-typed auth provider without the check as it was: the 403 surfaces', async function () {
        appRoleClient();
        await client.read('secret/a');
        const real = client.__auth;
        client.__auth = { getAuthToken: () => real.getAuthToken(), cancelTokenRefresh: () => real.cancelTokenRefresh() };
        vault.state.revoked.add('tok-1');

        const { error } = await settle(client.read('secret/a'));

        expect(error.statusCode).to.equal(403);
        expect(logins()).to.equal(1);
        expect(lookups('tok-1')).to.equal(1);
    });

    it('with autoDetect, leaves a detection the policy denies failing as before, without a login', async function () {
        appRoleClient({ api: { url, kv: { autoDetect: true } } });

        const { error } = await settle(client.read('secret/denied'));

        expect(error).to.be.instanceOf(errors.VaultError);
        expect(error.message).to.match(/^Failed to detect KV engine version for mount "secret" \(path: secret\/denied\): /);
        expect(error.cause).to.be.instanceOf(errors.VaultHttpError);
        expect(error.cause.statusCode).to.equal(403);
        expect(logins()).to.equal(1);
    });

    it('surfaces the 403 without logging in again when lookup-self fails for another reason', async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');
        vault.state.lookup = (reply) => {
            reply(500, { errors: ['internal error'] });
            return true;
        };

        const { error } = await settle(client.read('secret/a'));

        expect(error.statusCode).to.equal(403);
        expect(logins()).to.equal(1);
    });

    it('shares one lookup-self and one login between concurrent requests rejected with the same token', async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');

        const leases = await Promise.all([1, 2, 3, 4, 5].map((n) => client.read(`secret/c${n}`)));

        expect(leases.map((lease) => lease.getData().token)).to.deep.equal(['tok-2', 'tok-2', 'tok-2', 'tok-2', 'tok-2']);
        expect(logins()).to.equal(2);
        expect(lookups('tok-1')).to.equal(2);
    });

    it('leaves other errors alone: no lookup-self, no login', async function () {
        appRoleClient();
        await client.read('secret/a');

        const { error } = await settle(client.read('secret/missing'));

        expect(error.statusCode).to.equal(404);
        expect(lookups('tok-1')).to.equal(1);
        expect(logins()).to.equal(1);
    });

    it('re-sends a write with its method and body', async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');

        await client.write('secret/w', { k: 'v' });

        const writes = vault.state.log.filter((r) => r.path === '/v1/secret/w');
        expect(writes.map((r) => [r.method, r.token, r.body])).to.deep.equal([
            ['POST', 'tok-1', '{"k":"v"}'],
            ['POST', 'tok-2', '{"k":"v"}'],
        ]);
    });

    it('covers request() too', async function () {
        appRoleClient();
        await client.read('secret/a');
        vault.state.revoked.add('tok-1');

        const body = await client.request('GET', 'secret/raw');

        expect(body.data.token).to.equal('tok-2');
        expect(logins()).to.equal(2);
    });

    it('covers mount detection with autoDetect', async function () {
        appRoleClient({ api: { url, kv: { autoDetect: true } } });
        await client.request('GET', 'secret/warm-up');
        vault.state.revoked.add('tok-1');

        const lease = await client.read('secret/a');

        expect(lease.getData().token).to.equal('tok-2');
        expect(logins()).to.equal(2);
        expect(vault.count('GET', '/v1/sys/internal/ui/mounts/secret/a', 'tok-2')).to.equal(1);
    });

    it('cancels the dead token\'s renewal timer', async function () {
        vault.state.renewable = true;
        appRoleClient();
        await client.read('secret/a');
        const cancel = sinon.spy(client.__auth, 'cancelTokenRefresh');
        vault.state.revoked.add('tok-1');

        await client.read('secret/a');

        expect(cancel).to.have.been.calledOnce;
        expect(logins()).to.equal(2);
    });
});
