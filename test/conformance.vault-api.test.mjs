/**
 * Conformance tests: validate the client against the documented HashiCorp Vault HTTP API.
 */

import http from 'http';
import fs from 'fs';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultBaseAuth from '../src/auth/VaultBaseAuth.js';
import VaultAppRoleAuth from '../src/auth/VaultAppRoleAuth.js';
import VaultIAMAuth from '../src/auth/VaultIAMAuth.js';
import VaultKubernetesAuth from '../src/auth/VaultKubernetesAuth.js';
import VaultTokenAuth from '../src/auth/VaultTokenAuth.js';
import AuthToken from '../src/auth/AuthToken.js';
import Lease from '../src/Lease.js';
import errors from '../src/errors.js';
import { createNoopLogger } from './helpers/logger.mjs';

use(sinonChai);

const logger = createNoopLogger();
const apiStub = () => sinon.createStubInstance(VaultApiClient);
const b64decode = (s) => Buffer.from(s, 'base64').toString();

describe('Vault API conformance', function () {
    describe('transport (VaultApiClient)', function () {
        let server;
        let baseUrl;
        let seen;

        before(function (done) {
            server = http.createServer((req, res) => {
                seen = { method: req.method, url: req.url };
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true }));
            });
            server.listen(0, '127.0.0.1', () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                done();
            });
        });

        after(function (done) {
            server.closeAllConnections();
            server.close(done);
        });

        it('prefixes the documented /v1 API version on the wire', function () {
            const api = new VaultApiClient({ url: baseUrl }, logger);
            return api.makeRequest('GET', '/secret/foo').then(() => {
                expect(seen.url).to.equal('/v1/secret/foo');
            });
        });
    });

    describe('KV v1 verbs (VaultClient)', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient({
                api: { url: 'https://vault.example/' },
                logger: false,
                auth: { type: 'token', config: { token: 't' } },
            });
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
            client.__api = { makeRequest: sinon.stub().resolves({ data: {} }) };
        });

        it('reads with GET and the X-Vault-Token header', function () {
            return client.read('secret/foo').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/foo', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('writes with POST and the X-Vault-Token header', function () {
            return client.write('secret/foo', { a: 1 }).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('POST', 'secret/foo', { a: 1 }, { 'X-Vault-Token': 'tid' });
            });
        });

        it('lists with the LIST verb (not GET)', function () {
            return client.list('secret').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('LIST', 'secret', null, { 'X-Vault-Token': 'tid' });
            });
        });
    });

    describe('secret response envelope (Lease)', function () {
        it('reads the documented read envelope fields', function () {
            const lease = Lease.fromResponse({
                request_id: 'req',
                lease_id: '',
                lease_duration: 3600,
                renewable: false,
                data: { foo: 'bar', ttl: '1h' },
            });
            expect(lease.isRenewable()).to.equal(false);
            expect(lease.getValue('foo')).to.equal('bar');
        });

        it('exposes data.keys from a LIST response', function () {
            const lease = Lease.fromResponse({ data: { keys: ['foo', 'foo/'] } });
            expect(lease.getValue('keys')).to.deep.equal(['foo', 'foo/']);
        });
    });

    describe('token auth', function () {
        it('looks a token up via GET /auth/token/lookup-self', function () {
            const api = apiStub();
            api.makeRequest.resolves({ data: { id: 't', accessor: 'a', creation_time: 1, ttl: 0, renewable: false } });
            const auth = new VaultBaseAuth(api, logger, 'token');
            return auth._getTokenEntity('the-token').then(() => {
                expect(api.makeRequest).to.have.been.calledWith('GET', '/auth/token/lookup-self', null, { 'X-Vault-Token': 'the-token' });
            });
        });

        it('renews a token via POST /auth/token/renew-self', function () {
            const api = apiStub();
            api.makeRequest.resolves({});
            const auth = new VaultBaseAuth(api, logger, 'token');
            sinon.stub(auth, '_getTokenEntity').resolves(new AuthToken('t', 'a', 0, null, 0, 0, false));
            const token = new AuthToken('the-token', 'a', 0, null, 0, 0, true);
            return auth.__renewToken(token).then(() => {
                expect(api.makeRequest).to.have.been.calledWith('POST', '/auth/token/renew-self', null, { 'X-Vault-Token': 'the-token' });
            });
        });

        it('VaultTokenAuth authenticates against lookup-self with the configured token', function () {
            const api = apiStub();
            api.makeRequest.resolves({ data: { id: 'cfg', accessor: 'a', creation_time: 1, ttl: 0, renewable: false } });
            const auth = new VaultTokenAuth(api, logger, { token: 'cfg' });
            return auth._authenticate().then(() => {
                expect(api.makeRequest).to.have.been.calledWith('GET', '/auth/token/lookup-self', null, { 'X-Vault-Token': 'cfg' });
            });
        });
    });

    describe('AppRole auth', function () {
        it('logs in with POST /auth/:mount/login and {role_id, secret_id}', function () {
            const api = apiStub();
            api.makeRequest.resolves({ auth: { client_token: 'ct' } });
            const auth = new VaultAppRoleAuth(api, logger, { role_id: 'r', secret_id: 's' }, 'approle');
            const getEntity = sinon.stub(auth, '_getTokenEntity').resolves();
            return auth._authenticate().then(() => {
                expect(api.makeRequest).to.have.been.calledWith('POST', '/auth/approle/login', { role_id: 'r', secret_id: 's' });
                expect(getEntity).to.have.been.calledWith('ct');
            });
        });
    });

    describe('AWS IAM auth', function () {
        it('builds the documented sts:GetCallerIdentity login body', function () {
            const api = apiStub();
            api.makeRequest.resolves({ auth: { client_token: 'ct' } });
            const auth = new VaultIAMAuth(api, logger, {
                role: 'MyRole',
                iam_server_id_header_value: 'https://vault.example',
                credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
            }, 'aws');
            const getEntity = sinon.stub(auth, '_getTokenEntity').resolves();

            return auth._authenticate().then(() => {
                const [method, path, body] = api.makeRequest.getCall(0).args;
                expect(method).to.equal('POST');
                expect(path).to.equal('/auth/aws/login');
                expect(body.role).to.equal('MyRole');
                expect(body.iam_http_request_method).to.equal('POST');
                expect(b64decode(body.iam_request_url)).to.equal('https://sts.amazonaws.com/');
                expect(b64decode(body.iam_request_body)).to.equal('Action=GetCallerIdentity&Version=2011-06-15');
                const headers = JSON.parse(b64decode(body.iam_request_headers));
                expect(headers['X-Vault-AWS-IAM-Server-ID']).to.deep.equal(['https://vault.example']);
                expect(headers['Authorization'][0]).to.match(/^AWS4-HMAC-SHA256 /);
                expect(getEntity).to.have.been.calledWith('ct');
            });
        });
    });

    describe('Kubernetes auth', function () {
        let readFileSync;
        afterEach(function () { if (readFileSync) { readFileSync.restore(); readFileSync = null; } });

        it('logs in with POST /auth/:mount/login and {role, jwt}', function () {
            readFileSync = sinon.stub(fs, 'readFileSync').returns(Buffer.from('signed-jwt'));
            const api = apiStub();
            api.makeRequest.resolves({ auth: { client_token: 'ct' } });
            const auth = new VaultKubernetesAuth(api, logger, { role: 'r', tokenPath: '/tok' }, 'kubernetes');
            const getEntity = sinon.stub(auth, '_getTokenEntity').resolves();
            return auth._authenticate().then(() => {
                expect(api.makeRequest).to.have.been.calledWith('POST', '/auth/kubernetes/login', { role: 'r', jwt: 'signed-jwt' });
                expect(getEntity).to.have.been.calledWith('ct');
            });
        });
    });

    describe('namespaces', function () {
        // Namespacing is owned by VaultApiClient#makeRequest, so it applies uniformly to login,
        // token lookup/renewal and secret operations. The full per-backend matrix lives in
        // test/namespace.test.mjs; here we validate the documented header on the wire and the
        // config resolution.
        it('sends the X-Vault-Namespace header on the wire when configured', function () {
            const fetchStub = sinon.stub(global, 'fetch').resolves(
                new Response(JSON.stringify({ data: {} }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
            );
            const api = new VaultApiClient({ url: 'https://vault.example' }, logger, 'team-a');
            return api.makeRequest('GET', '/secret/data/foo', null, { 'X-Vault-Token': 'tid' })
                .then(() => {
                    const headers = fetchStub.firstCall.args[1].headers;
                    expect(headers['X-Vault-Namespace']).to.equal('team-a');
                    expect(headers['X-Vault-Token']).to.equal('tid');
                })
                .finally(() => fetchStub.restore());
        });

        it('resolves auth.config.namespace onto the shared API client', function () {
            const client = new VaultClient({
                api: { url: 'https://vault.example/' },
                logger: false,
                auth: { type: 'token', config: { token: 't', namespace: 'team-a' } },
            });
            expect(client.__api.__namespace).to.equal('team-a');
            // getHeaders no longer carries the namespace — the transport injects it.
            expect(client.getHeaders({ getId: () => 'tid' })).to.deep.equal({ 'X-Vault-Token': 'tid' });
        });
    });

    describe('token expiry', function () {
        it('derives expiry from the documented expire_time (minus the safety margin)', function () {
            const token = AuthToken.fromResponse({
                data: {
                    id: 's.token',
                    accessor: 'acc',
                    creation_time: 1600000000,
                    creation_ttl: 2764800,
                    ttl: 2764790,
                    expire_time: '2020-10-16T00:00:00Z',
                    explicit_max_ttl: 0,
                    num_uses: 0,
                    renewable: true,
                },
            });
            expect(token.getExpiresAt()).to.equal(Math.floor(Date.parse('2020-10-16T00:00:00Z') / 1000) - 60);
            expect(token.isRenewable()).to.equal(true);
        });

        it('treats ttl === 0 (root / non-expiring token) as never expiring', function () {
            const token = AuthToken.fromResponse({
                data: { id: 'root', accessor: 'a', creation_time: 1600000000, ttl: 0, renewable: false },
            });
            expect(token.getExpiresAt()).to.equal(null);
            expect(token.isExpired()).to.equal(false);
        });
    });

    // -------------------------------------------------------------------------
    // KV v2 transport conformance
    // -------------------------------------------------------------------------
    describe('KV v2 verbs (VaultClient)', function () {
        let client;
        const token = { getId: () => 'tid' };
        const headers = { 'X-Vault-Token': 'tid' };

        function makeV2Client(engines) {
            const c = new VaultClient({
                api: { url: 'https://vault.example/', engines },
                logger: false,
                auth: { type: 'token', config: { token: 't' } },
            });
            c.__auth = { getAuthToken: sinon.stub().resolves(token) };
            return c;
        }

        beforeEach(function () {
            client = makeV2Client({ secret: 2 });
        });

        afterEach(function () {
            VaultClient.clear();
        });

        it('read rewrites path to data/ and unwraps inner data', function () {
            client.__api = { makeRequest: sinon.stub().resolves({
                data: { data: { pw: 'abc' }, metadata: { version: 1 } },
            }) };
            return client.read('secret/foo').then((lease) => {
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/data/foo', null, headers);
                expect(lease.getData()).to.deep.equal({ pw: 'abc' });
                expect(lease.getMetadata()).to.deep.equal({ version: 1 });
            });
        });

        it('write wraps payload in { data } and rewrites path to data/', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { version: 1 } }) };
            return client.write('secret/foo', { pw: 'abc' }).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/data/foo', { data: { pw: 'abc' } }, headers
                );
            });
        });

        it('list rewrites path to metadata/', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { keys: ['foo'] } }) };
            return client.list('secret').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('LIST', 'secret/metadata/', null, headers);
            });
        });

        it('delete soft-deletes latest version via DELETE to data/', function () {
            client.__api = { makeRequest: sinon.stub().resolves(null) };
            return client.delete('secret/foo').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('DELETE', 'secret/data/foo', null, headers);
            });
        });

        it('update sends PATCH with merge-patch+json and { data } envelope to data/', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { version: 2 } }) };
            return client.update('secret/foo', { pw: 'new' }).then(() => {
                const [method, path, data, hdrs] = client.__api.makeRequest.getCall(0).args;
                expect(method).to.equal('PATCH');
                expect(path).to.equal('secret/data/foo');
                expect(data).to.deep.equal({ data: { pw: 'new' } });
                expect(hdrs['Content-Type']).to.equal('application/merge-patch+json');
            });
        });

        it('deleteVersions sends POST to delete/ with { versions }', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.deleteVersions('secret/foo', [1, 2]).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/delete/foo', { versions: [1, 2] }, headers
                );
            });
        });

        it('undeleteVersions sends POST to undelete/', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.undeleteVersions('secret/foo', [1]).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/undelete/foo', { versions: [1] }, headers
                );
            });
        });

        it('destroyVersions sends POST to destroy/', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.destroyVersions('secret/foo', [2]).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/destroy/foo', { versions: [2] }, headers
                );
            });
        });

        it('readMetadata sends GET to metadata/ and unwraps data', function () {
            client.__api = { makeRequest: sinon.stub().resolves({
                request_id: 'r',
                data: { current_version: 3, versions: {} },
            }) };
            return client.readMetadata('secret/foo').then((body) => {
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/metadata/foo', null, headers);
                expect(body.data).to.deep.equal({ current_version: 3, versions: {} });
            });
        });

        it('deleteMetadata sends DELETE to metadata/', function () {
            client.__api = { makeRequest: sinon.stub().resolves(null) };
            return client.deleteMetadata('secret/foo').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('DELETE', 'secret/metadata/foo', null, headers);
            });
        });

        it('request() sends literal path without rewriting', function () {
            const body = { ciphertext: 'vault:v1:xyz' };
            client.__api = { makeRequest: sinon.stub().resolves(body) };
            return client.request('POST', 'transit/encrypt/mykey', { plaintext: 'dA==' }).then((res) => {
                expect(res).to.equal(body);
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'transit/encrypt/mykey', { plaintext: 'dA==' }, headers
                );
            });
        });

        it('v2-only helpers throw UnsupportedOperationError on a v1 mount', function () {
            const v1Client = makeV2Client({ secret: 1 });
            v1Client.__api = { makeRequest: sinon.stub().resolves({}) };
            return v1Client.deleteVersions('secret/foo', [1]).then(
                () => { throw new Error('expected rejection'); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.UnsupportedOperationError);
                }
            );
        });

        it('VaultApiClient preserves caller Content-Type (no override for merge-patch)', function () {
            // Regression: VaultApiClient must NOT override Content-Type when already set
            let server;
            let seen = {};
            return new Promise((resolve) => {
                server = http.createServer((req, res) => {
                    seen.contentType = req.headers['content-type'];
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ok: true }));
                });
                server.listen(0, '127.0.0.1', () => resolve(server.address().port));
            }).then((port) => {
                const api = new VaultApiClient({ url: `http://127.0.0.1:${port}` }, logger);
                return api.makeRequest('PATCH', '/secret/data/foo', { data: { k: 'v' } }, {
                    'Content-Type': 'application/merge-patch+json',
                }).then(() => {
                    expect(seen.contentType).to.equal('application/merge-patch+json');
                }).finally(() => {
                    server.closeAllConnections();
                    server.close();
                });
            });
        });

        it('detects mount via sys/internal/ui/mounts when autoDetect:true', function () {
            const autoClient = new VaultClient({
                api: { url: 'https://vault.example/', kv: { autoDetect: true } },
                logger: false,
                auth: { type: 'token', config: { token: 't' } },
            });
            autoClient.__auth = { getAuthToken: sinon.stub().resolves(token) };

            // First call returns the mount info; second call returns the actual secret
            const makeRequest = sinon.stub();
            makeRequest.onFirstCall().resolves({
                data: { path: 'secret/', type: 'kv', options: { version: '2' } },
            });
            makeRequest.onSecondCall().resolves({
                data: { data: { pw: 'x' }, metadata: { version: 1 } },
            });
            autoClient.__api = { makeRequest };

            return autoClient.read('secret/foo').then((lease) => {
                // First call: detection endpoint
                const [, detectPath] = makeRequest.getCall(0).args;
                expect(detectPath).to.include('sys/internal/ui/mounts');
                // Second call: actual read at v2 path
                expect(makeRequest).to.have.been.calledWith('GET', 'secret/data/foo', null, headers);
                expect(lease.getData()).to.deep.equal({ pw: 'x' });
                autoClient.close();
            });
        });
    });
});
