'use strict';

/**
 * Conformance tests: validate the client against the documented HashiCorp Vault HTTP API.
 *
 * Each assertion is cross-referenced with the official Vault API documentation
 * (developer.hashicorp.com/vault/api-docs). These tests pin the on-the-wire contract
 * the client produces (HTTP verb, path, request body keys, headers) and the response
 * fields it consumes, so a regression against the documented Vault API fails loudly.
 *
 * NOTE: these are intentionally test-only. They document current behaviour (including the
 * token-expiry deviation called out at the bottom); they do not change src/.
 */

const http = require('http');
const _ = require('lodash');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const VaultClient = require('../src/VaultClient');
const VaultApiClient = require('../src/VaultApiClient');
const VaultBaseAuth = require('../src/auth/VaultBaseAuth');
const VaultAppRoleAuth = require('../src/auth/VaultAppRoleAuth');
const VaultIAMAuth = require('../src/auth/VaultIAMAuth');
const VaultKubernetesAuth = require('../src/auth/VaultKubernetesAuth');
const VaultTokenAuth = require('../src/auth/VaultTokenAuth');
const AuthToken = require('../src/auth/AuthToken');
const Lease = require('../src/Lease');

const logger = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (p) => [p, _.noop]));
const apiStub = () => sinon.createStubInstance(VaultApiClient);
const b64decode = (s) => Buffer.from(s, 'base64').toString();

describe('Vault API conformance', function () {
    // -----------------------------------------------------------------------
    // Transport — every request is rooted at /{apiVersion}/... (default "v1").
    // Ref: api-docs examples all use http://127.0.0.1:8200/v1/...
    // -----------------------------------------------------------------------
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
            // fetch (undici) keeps sockets alive in a pool; drop them so close() returns
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

    // -----------------------------------------------------------------------
    // KV v1 verbs — read=GET, write=POST, list=LIST (the LIST HTTP verb).
    // Ref: api-docs/secret/kv/kv-v1 — "List secrets: LIST /secret/:path
    // (using the LIST HTTP verb, not GET)".
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Standard secret response envelope.
    // Ref: api-docs/secret/kv/kv-v1 read example: top-level lease_id,
    // lease_duration, renewable, data; list returns data.keys (folders suffixed "/").
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Token auth method.
    // Ref: api-docs/auth/token
    //   lookup-self: GET  /auth/token/lookup-self  (X-Vault-Token header)
    //   renew-self : POST /auth/token/renew-self   (X-Vault-Token header)
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // AppRole auth method.
    // Ref: api-docs/auth/approle — POST /auth/:mount/login with {role_id, secret_id};
    // response auth.client_token.
    // -----------------------------------------------------------------------
    describe('AppRole auth', function () {
        it('logs in with POST /auth/:mount/login and {role_id, secret_id}', function () {
            const api = apiStub();
            api.makeRequest.resolves({ auth: { client_token: 'ct' } });
            const auth = new VaultAppRoleAuth(api, logger, { role_id: 'r', secret_id: 's' }, 'approle');
            const getEntity = sinon.stub(auth, '_getTokenEntity').resolves();
            return auth._authenticate().then(() => {
                expect(api.makeRequest).to.have.been.calledWith('POST', '/auth/approle/login', { role_id: 'r', secret_id: 's' });
                // consumes auth.client_token from the response
                expect(getEntity).to.have.been.calledWith('ct');
            });
        });
    });

    // -----------------------------------------------------------------------
    // AWS IAM auth method.
    // Ref: api-docs/auth/aws — POST /auth/:mount/login with role,
    // iam_http_request_method, iam_request_url (b64 of https://sts.amazonaws.com/),
    // iam_request_body (b64 of Action=GetCallerIdentity&Version=2011-06-15),
    // iam_request_headers (b64 JSON). X-Vault-AWS-IAM-Server-ID must be a signed header.
    // -----------------------------------------------------------------------
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
                // X-Vault-AWS-IAM-Server-ID present and signed (golang-style array value)
                expect(headers['X-Vault-AWS-IAM-Server-ID']).to.deep.equal(['https://vault.example']);
                expect(headers['Authorization'][0]).to.match(/^AWS4-HMAC-SHA256 /);
                expect(getEntity).to.have.been.calledWith('ct');
            });
        });
    });

    // -----------------------------------------------------------------------
    // Kubernetes auth method.
    // Ref: api-docs/auth/kubernetes — POST /auth/:mount/login with {role, jwt}.
    // -----------------------------------------------------------------------
    describe('Kubernetes auth', function () {
        let readFileSync;
        afterEach(function () { if (readFileSync) { readFileSync.restore(); readFileSync = null; } });

        it('logs in with POST /auth/:mount/login and {role, jwt}', function () {
            const fs = require('fs');
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

    // -----------------------------------------------------------------------
    // Vault Enterprise namespaces.
    // Ref: api-docs — namespace selection via the X-Vault-Namespace header.
    // -----------------------------------------------------------------------
    describe('namespaces', function () {
        it('selects a namespace with the X-Vault-Namespace header on KV requests', function () {
            const client = new VaultClient({
                api: { url: 'https://vault.example/' },
                logger: false,
                auth: { type: 'token', config: { token: 't', namespace: 'team-a' } },
            });
            expect(client.getHeaders({ getId: () => 'tid' })).to.deep.equal({
                'X-Vault-Token': 'tid',
                'X-Vault-Namespace': 'team-a',
            });
        });

        it('sends X-Vault-Namespace on the AppRole login request', function () {
            const api = apiStub();
            api.makeRequest.resolves({ auth: { client_token: 'ct' } });
            const auth = new VaultAppRoleAuth(api, logger, { role_id: 'r', secret_id: 's', namespace: 'team-a' }, 'approle');
            sinon.stub(auth, '_getTokenEntity').resolves();
            return auth._authenticate().then(() => {
                const headers = api.makeRequest.getCall(0).args[3];
                expect(headers).to.deep.equal({ 'X-Vault-Namespace': 'team-a' });
            });
        });
    });

    // -----------------------------------------------------------------------
    // Token expiry.
    //
    // Vault's lookup-self response documents `expire_time` (RFC3339) as the
    // authoritative absolute expiry, alongside `creation_time` (unix seconds, when
    // the token was CREATED) and `ttl` (REMAINING seconds, counting down at lookup).
    //
    // AuthToken.fromResponse derives the expiry from `expire_time` (minus a 60s
    // network-latency safety margin), falling back to
    // `(last_renewal_time || creation_time) + ttl` only for responses that don't
    // carry `expire_time`. Using `expire_time` is correct regardless of how long
    // after issuance the lookup happens.
    // -----------------------------------------------------------------------
    describe('token expiry', function () {
        it('derives expiry from the documented expire_time (minus the safety margin)', function () {
            const token = AuthToken.fromResponse({
                data: {
                    id: 's.token',
                    accessor: 'acc',
                    creation_time: 1600000000,
                    creation_ttl: 2764800,
                    ttl: 2764790,                       // remaining at lookup
                    expire_time: '2020-10-16T00:00:00Z', // authoritative per docs
                    explicit_max_ttl: 0,
                    num_uses: 0,
                    renewable: true,
                },
            });
            // expire_time epoch (1602806400) minus the 60s margin, NOT creation_time + ttl
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
});
