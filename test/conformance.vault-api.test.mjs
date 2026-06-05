/**
 * Conformance tests: validate the client against the documented HashiCorp Vault HTTP API.
 */

import http from 'http';
import fs from 'fs';
import _ from 'lodash';
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

use(sinonChai);

const logger = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (p) => [p, _.noop]));
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
});
