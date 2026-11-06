/**
 * Redirects (issue #232): requests follow redirects only within the origin of api.url, so the
 * Vault token and login credentials never reach another origin and its answer is never read
 * as Vault's. A requestOptions.redirect is passed to fetch() as it is.
 */
import http from 'node:http';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultClient from '../src/VaultClient.js';
import errors from '../src/errors.js';
import { createNoopLogger } from './helpers/logger.mjs';

use(sinonChai);

function settle(promise) {
    return promise.then((value) => ({ value }), (error) => ({ error }));
}

/** An HTTP server that records every request it receives. */
function recordingServer(handler) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const request = {
                method: req.method,
                path: req.url,
                body,
                contentType: req.headers['content-type'],
                token: req.headers['x-vault-token'],
            };
            seen.push(request);
            handler(request, res);
        });
    });
    return { server, seen };
}

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
}

function json(res, status, body, headers = {}) {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
    res.end(JSON.stringify(body));
}

describe('redirects (#232)', function () {
    let vault;
    let capture;
    let vaultUrl;
    let captureUrl;

    before(async function () {
        capture = recordingServer((request, res) => json(res, 200, { data: { captured: true } }));
        vault = recordingServer((request, res) => {
            const { path } = request;
            let match;
            if (path === '/v1/auth/token/lookup-self') {
                json(res, 200, { data: { id: 'client-token', accessor: 'acc', ttl: 0, renewable: false } });
            } else if (path === '/v1/secret/cross') {
                res.writeHead(302, { Location: `${captureUrl}/v1/secret/stolen` });
                res.end('moved');
            } else if (path === '/v1/auth/approle/login') {
                res.writeHead(307, { Location: `${captureUrl}/v1/auth/approle/login` });
                res.end();
            } else if (path === '/v1/secret/same') {
                res.writeHead(302, { Location: '/v1/secret/target' });
                res.end();
            } else if ((match = /^\/v1\/redirect\/(\d+)$/.exec(path))) {
                res.writeHead(Number(match[1]), { Location: '/v1/echo' });
                res.end('{"not":"vault data"}');
            } else if ((match = /^\/v1\/chain\/(\d+)$/.exec(path))) {
                const left = Number(match[1]);
                res.writeHead(left > 0 ? 302 : 200, left > 0 ? { Location: `/v1/chain/${left - 1}` } : {});
                res.end(left > 0 ? '' : '{"data":{"end":true}}');
            } else if (path === '/v1/relative/a') {
                res.writeHead(302, { Location: 'b' });
                res.end();
            } else if (path === '/v1/no-location') {
                res.writeHead(302);
                res.end('{"errors":[]}');
            } else {
                json(res, 200, { data: request });
            }
        });
        vaultUrl = await listen(vault.server);
        captureUrl = await listen(capture.server);
    });

    after(function () {
        vault.server.closeAllConnections();
        vault.server.close();
        capture.server.closeAllConnections();
        capture.server.close();
    });

    beforeEach(function () {
        vault.seen.length = 0;
        capture.seen.length = 0;
    });

    afterEach(function () {
        sinon.restore();
        VaultClient.clear();
    });

    const api = (extra = {}) => new VaultApiClient(Object.assign({ url: vaultUrl }, extra), createNoopLogger());

    describe('to another origin', function () {
        it('is refused: the token never reaches it and its answer is not returned', async function () {
            const { error } = await settle(api().makeRequest('GET', '/secret/cross', null, { 'X-Vault-Token': 'secret-token' }));

            expect(error).to.be.instanceOf(errors.VaultError);
            expect(error).not.to.be.instanceOf(errors.VaultHttpError);
            expect(error.message).to.equal(
                `Refusing to follow a redirect from ${vaultUrl} to ${captureUrl}: ` +
                'only redirects within the origin of "api.url" are followed');
            expect(capture.seen).to.deep.equal([]);
        });

        it('names origins only, not the paths of either URL', async function () {
            const { error } = await settle(api().makeRequest('GET', '/secret/cross'));

            expect(error.message).not.to.include('/v1/');
        });

        it('is refused for a read through VaultClient: the client token stays with Vault', async function () {
            const client = new VaultClient({
                api: { url: vaultUrl },
                logger: createNoopLogger(),
                auth: { type: 'token', renewal: false, config: { token: 'client-token' } },
            });

            const { error } = await settle(client.read('secret/cross'));

            expect(error).to.be.instanceOf(errors.VaultError);
            expect(capture.seen).to.deep.equal([]);
            expect(vault.seen.find((r) => r.path === '/v1/secret/cross').token).to.equal('client-token');
        });

        it('is refused for a 307 on login: role_id and secret_id never leave the configured origin', async function () {
            const client = new VaultClient({
                api: { url: vaultUrl },
                logger: createNoopLogger(),
                auth: { type: 'appRole', renewal: false, config: { role_id: 'ROLE-ID-1', secret_id: 'SECRET-ID-2' } },
            });

            const { error } = await settle(client.read('secret/anything'));

            expect(error).to.be.instanceOf(errors.VaultError);
            expect(error.message).to.include(`to ${captureUrl}:`);
            expect(capture.seen).to.deep.equal([]);
            const login = vault.seen.find((r) => r.path === '/v1/auth/approle/login');
            expect(JSON.parse(login.body)).to.deep.equal({ role_id: 'ROLE-ID-1', secret_id: 'SECRET-ID-2' });
        });

        it('is refused when it downgrades https to http on the same host and port', async function () {
            const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
                new Response(null, { status: 307, headers: { Location: 'http://vault.example:8200/v1/secret/x' } }));
            const client = new VaultApiClient({ url: 'https://vault.example:8200' }, createNoopLogger());

            const { error } = await settle(client.makeRequest('GET', '/secret/x', null, { 'X-Vault-Token': 't' }));

            expect(error).to.be.instanceOf(errors.VaultError);
            expect(error.message).to.include('from https://vault.example:8200 to http://vault.example:8200');
            expect(fetchStub).to.have.been.calledOnce;
        });

        it('is refused when the Location is not http(s)', async function () {
            sinon.stub(globalThis, 'fetch').resolves(
                new Response(null, { status: 302, headers: { Location: 'file:///etc/passwd' } }));

            const { error } = await settle(api().makeRequest('GET', '/secret/x'));

            expect(error).to.be.instanceOf(errors.VaultError);
            expect(error.message).to.match(/^Refusing to follow a redirect from /);
        });

        it('is refused after same-origin hops that lead to it', async function () {
            const fetchStub = sinon.stub(globalThis, 'fetch');
            fetchStub.onFirstCall().resolves(new Response(null, { status: 302, headers: { Location: '/v1/secret/b' } }));
            fetchStub.onSecondCall().resolves(new Response(null, { status: 308, headers: { Location: `${captureUrl}/v1/x` } }));

            const { error } = await settle(api().makeRequest('GET', '/secret/a'));

            expect(error.message).to.include(`to ${captureUrl}:`);
            expect(fetchStub).to.have.been.calledTwice;
        });
    });

    describe('within the origin', function () {
        it('is followed exactly once and the target answers', async function () {
            const body = await api().makeRequest('GET', '/secret/same', null, { 'X-Vault-Token': 't' });

            expect(body.data).to.include({ method: 'GET', path: '/v1/secret/target', token: 't' });
            expect(vault.seen.map((r) => r.path)).to.deep.equal(['/v1/secret/same', '/v1/secret/target']);
        });

        it('resolves a relative Location against the URL that answered', async function () {
            const body = await api().makeRequest('GET', '/relative/a');

            expect(body.data.path).to.equal('/v1/relative/b');
        });

        it('follows 20 redirects, as fetch() does, and refuses the 21st', async function () {
            expect(await api().makeRequest('GET', '/chain/20')).to.deep.equal({ data: { end: true } });

            const { error } = await settle(api().makeRequest('GET', '/chain/21'));
            expect(error).to.be.instanceOf(errors.VaultError);
            expect(error.message).to.equal('Refusing to follow more than 20 redirects');
        });

        it('returns a redirect without a Location as a VaultHttpError, as before', async function () {
            const { error } = await settle(api().makeRequest('GET', '/no-location'));

            expect(error).to.be.instanceOf(errors.VaultHttpError);
            expect(error.statusCode).to.equal(302);
        });

        it('sends the same request that fetch()\'s own "follow" sends, for every redirect status and method', async function () {
            const own = api();
            const follow = api({ requestOptions: { redirect: 'follow' } });
            for (const status of [301, 302, 303, 307, 308]) {
                for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'post']) {
                    const data = method === 'GET' ? null : { a: 1 };
                    const headers = { 'X-Vault-Token': 't', 'X-Vault-Namespace': 'ns' };
                    const label = `${status} ${method}`;

                    const expected = await follow.makeRequest(method, `/redirect/${status}`, data, headers);
                    const actual = await own.makeRequest(method, `/redirect/${status}`, data, headers);

                    expect(actual, label).to.deep.equal(expected);
                    expect(actual.data.path, label).to.equal('/v1/echo');
                }
            }
        });

        it('drops the body and its Content-Type when a 303 turns the request into a GET', async function () {
            const body = await api().makeRequest('PUT', '/redirect/303', { a: 1 }, { 'X-Vault-Token': 't' });

            expect(body.data).to.include({ method: 'GET', body: '', token: 't' });
            expect(body.data).not.to.have.property('contentType');
        });

        it('replays a 307 with its method and body', async function () {
            const body = await api().makeRequest('POST', '/redirect/307', { a: 1 }, { 'X-Vault-Token': 't' });

            expect(body.data).to.include({ method: 'POST', body: '{"a":1}', contentType: 'application/json', token: 't' });
        });

        it('keeps the request deadline across the hops', async function () {
            const fetchStub = sinon.stub(globalThis, 'fetch');
            fetchStub.onFirstCall().resolves(new Response(null, { status: 302, headers: { Location: '/v1/secret/b' } }));
            fetchStub.onSecondCall().resolves(new Response('{}', { status: 200 }));

            await api({ timeout: 5000 }).makeRequest('GET', '/secret/a');

            const [first, second] = fetchStub.getCalls().map((call) => call.args[1].signal);
            expect(first).to.be.instanceOf(AbortSignal);
            expect(second).to.equal(first);
        });
    });

    describe('with requestOptions.redirect', function () {
        it('"follow" keeps the old behavior: fetch() follows to any origin', async function () {
            const body = await api({ requestOptions: { redirect: 'follow' } })
                .makeRequest('GET', '/secret/cross', null, { 'X-Vault-Token': 't' });

            expect(body).to.deep.equal({ data: { captured: true } });
            expect(capture.seen).to.have.lengthOf(1);
        });

        it('"manual" returns the redirect as a VaultHttpError, as before', async function () {
            const { error } = await settle(api({ requestOptions: { redirect: 'manual' } }).makeRequest('GET', '/secret/same'));

            expect(error).to.be.instanceOf(errors.VaultHttpError);
            expect(error.statusCode).to.equal(302);
            expect(vault.seen).to.have.lengthOf(1);
        });

        it('"error" makes fetch() reject, as before', async function () {
            const { error } = await settle(api({ requestOptions: { redirect: 'error' } }).makeRequest('GET', '/secret/same'));

            expect(error).to.be.instanceOf(TypeError);
            expect(vault.seen).to.have.lengthOf(1);
        });

        it('is passed to fetch() as it is, and only an unset one gets "manual"', async function () {
            const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(() => Promise.resolve(new Response('{}')));

            await api({ requestOptions: { redirect: 'follow' } }).makeRequest('GET', '/x');
            await api().makeRequest('GET', '/x');
            await api({ requestOptions: { redirect: undefined } }).makeRequest('GET', '/x');

            expect(fetchStub.getCalls().map((call) => call.args[1].redirect)).to.deep.equal(['follow', 'manual', 'manual']);
        });
    });
});
