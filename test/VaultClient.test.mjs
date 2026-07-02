import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import VaultNodeConfig from '../src/VaultNodeConfig.js';
import Lease from '../src/Lease.js';
import VaultTokenAuth from '../src/auth/VaultTokenAuth.js';
import VaultAppRoleAuth from '../src/auth/VaultAppRoleAuth.js';
import VaultIAMAuth from '../src/auth/VaultIAMAuth.js';
import VaultKubernetesAuth from '../src/auth/VaultKubernetesAuth.js';
import errors from '../src/errors.js';
import MountResolver from '../src/MountResolver.js';

use(sinonChai);

function bootOpts(overrides) {
    return _.merge({
        api: { url: 'https://example.com/' },
        logger: false,
        auth: {
            type: 'token',
            config: { token: 'tok-123' },
        },
    }, overrides);
}

describe('VaultClient', function () {
    afterEach(function () {
        VaultClient.clear();
    });

    describe('static boot/get/clear', function () {
        it('throws when options are not provided to boot', function () {
            expect(() => VaultClient.boot('x')).to.throw(errors.InvalidArgumentsError, 'Options should be provided');
        });

        it('creates, caches and returns the same instance', function () {
            const i = VaultClient.boot('main', bootOpts());
            expect(i).to.be.instanceOf(VaultClient);
            expect(VaultClient.boot('main', bootOpts())).to.equal(i);
            expect(VaultClient.get('main')).to.equal(i);
        });

        it('throws when getting an unknown instance', function () {
            expect(() => VaultClient.get('does-not-exist')).to.throw(errors.InvalidArgumentsError, 'Invalid instance name');
        });

        it('clears a single named instance', function () {
            const i = VaultClient.boot('a', bootOpts());
            VaultClient.boot('b', bootOpts());
            VaultClient.clear('a');
            expect(() => VaultClient.get('a')).to.throw(errors.InvalidArgumentsError);
            expect(VaultClient.get('b')).to.be.instanceOf(VaultClient);
            expect(VaultClient.boot('a', bootOpts())).to.not.equal(i);
        });

        it('clears every instance when no name is given', function () {
            VaultClient.boot('a', bootOpts());
            VaultClient.boot('b', bootOpts());
            VaultClient.clear();
            expect(() => VaultClient.get('a')).to.throw();
            expect(() => VaultClient.get('b')).to.throw();
        });
    });

    describe('#close()', function () {
        it('delegates to the auth provider\'s cancelTokenRefresh', function () {
            const client = new VaultClient(bootOpts());
            const cancel = sinon.stub();
            client.__auth = { cancelTokenRefresh: cancel };
            client.close();
            expect(cancel).to.have.been.calledOnce;
        });

        it('is null-safe when the auth provider lacks cancelTokenRefresh', function () {
            const client = new VaultClient(bootOpts());
            client.__auth = {};
            expect(() => client.close()).to.not.throw();
            client.__auth = null;
            expect(() => client.close()).to.not.throw();
        });
    });

    describe('static clear() releases timers', function () {
        it('calls close() on a single named instance before removing it', function () {
            const i = VaultClient.boot('a', bootOpts());
            const spy = sinon.spy(i, 'close');
            VaultClient.clear('a');
            expect(spy).to.have.been.calledOnce;
        });

        it('calls close() on every instance when clearing all', function () {
            const a = VaultClient.boot('a', bootOpts());
            const b = VaultClient.boot('b', bootOpts());
            const sa = sinon.spy(a, 'close');
            const sb = sinon.spy(b, 'close');
            VaultClient.clear();
            expect(sa).to.have.been.calledOnce;
            expect(sb).to.have.been.calledOnce;
        });
    });

    describe('auth provider selection', function () {
        const cases = [
            ['token', { token: 'tok' }, VaultTokenAuth],
            ['appRole', { role_id: 'rid' }, VaultAppRoleAuth],
            ['iam', { role: 'r' }, VaultIAMAuth],
            ['kubernetes', { role: 'r' }, VaultKubernetesAuth],
        ];

        cases.forEach(([type, config, Klass]) => {
            it(`builds a ${Klass.name} for the "${type}" auth type`, function () {
                const client = new VaultClient(bootOpts({ auth: { type, config } }));
                expect(client.__auth).to.be.instanceOf(Klass);
            });
        });

        it('throws for an unsupported auth type', function () {
            expect(() => new VaultClient(bootOpts({ auth: { type: 'nope', config: {} } })))
                .to.throw(errors.InvalidArgumentsError, 'Unsupported auth method');
        });
    });

    describe('#getHeaders()', function () {
        const token = { getId: () => 'tid' };

        it('returns only the token header', function () {
            const client = new VaultClient(bootOpts());
            expect(client.getHeaders(token)).to.deep.equal({ 'X-Vault-Token': 'tid' });
        });

        it('does not add the namespace header (namespace is injected centrally by VaultApiClient)', function () {
            const client = new VaultClient(bootOpts({ auth: { config: { namespace: 'ns1' } } }));
            // The namespace is applied to every request inside VaultApiClient#makeRequest, so
            // getHeaders itself no longer carries it (see test/namespace.test.mjs for the wire-level proof).
            expect(client.getHeaders(token)).to.deep.equal({ 'X-Vault-Token': 'tid' });
        });

        it('resolves the namespace from auth.config.namespace onto the API client', function () {
            const client = new VaultClient(bootOpts({ auth: { config: { namespace: 'ns1' } } }));
            expect(client.__api.__namespace).to.equal('ns1');
        });

        it('prefers api.namespace over the legacy auth.config.namespace', function () {
            const client = new VaultClient(bootOpts({
                api: { namespace: 'from-api' },
                auth: { config: { namespace: 'from-auth' } },
            }));
            expect(client.__api.__namespace).to.equal('from-api');
        });
    });

    describe('secret operations', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts());
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('read() issues a GET and wraps the response in a Lease', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ request_id: 'r', data: { k: 'v' } }) };
            return client.read('secret/x').then((lease) => {
                expect(lease).to.be.instanceOf(Lease);
                expect(lease.getData()).to.deep.equal({ k: 'v' });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/x', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('list() issues a LIST and wraps the response in a Lease', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { keys: ['a'] } }) };
            return client.list('secret').then((lease) => {
                expect(lease).to.be.instanceOf(Lease);
                expect(lease.getData()).to.deep.equal({ keys: ['a'] });
                expect(client.__api.makeRequest).to.have.been.calledWith('LIST', 'secret', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('write() issues a POST and returns the raw response', function () {
            const response = { data: { ip: '127.0.0.1' } };
            client.__api = { makeRequest: sinon.stub().resolves(response) };
            return client.write('secret/x', { a: 1 }).then((res) => {
                expect(res).to.equal(response);
                expect(client.__api.makeRequest).to.have.been.calledWith('POST', 'secret/x', { a: 1 }, { 'X-Vault-Token': 'tid' });
            });
        });

        ['read', 'list', 'write'].forEach((method) => {
            it(`${method}() rejects with the underlying error`, function () {
                const boom = new Error('boom');
                client.__api = { makeRequest: sinon.stub().rejects(boom) };
                return client[method]('secret/x', {}).then(
                    () => { throw new Error('expected rejection'); },
                    (err) => { expect(err).to.equal(boom); }
                );
            });
        });
    });

    describe('#__setupLogger()', function () {
        let client;
        beforeEach(function () { client = new VaultClient(bootOpts()); });

        it('returns an all-noop logger when given false', function () {
            const log = client.__setupLogger(false);
            for (const method of ['error', 'warn', 'info', 'debug', 'trace']) {
                expect(log[method]).to.be.a('function');
                expect(log[method]()).to.be.undefined;
            }
        });

        it('returns the supplied logger when it implements the full interface', function () {
            const custom = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (p) => [p, _.noop]));
            expect(client.__setupLogger(custom)).to.equal(custom);
        });

        it('falls back to console for an incomplete logger (with a silent debug)', function () {
            const log = client.__setupLogger({});
            expect(log.error).to.equal(console.error);
            expect(log.warn).to.equal(console.warn);
            expect(log.debug).to.be.a('function');
            expect(log.debug).to.not.equal(console.debug);
            expect(log.debug()).to.be.undefined;
        });
    });

    describe('#fillNodeConfig()', function () {
        it('delegates to VaultNodeConfig#populate', function () {
            const sentinel = Promise.resolve('populated');
            const populate = sinon.stub(VaultNodeConfig.prototype, 'populate').returns(sentinel);
            try {
                const client = new VaultClient(bootOpts());
                const result = client.fillNodeConfig();
                expect(populate).to.have.been.calledOnce;
                return result.then((value) => expect(value).to.equal('populated'));
            } finally {
                populate.restore();
            }
        });
    });

    // -------------------------------------------------------------------------
    // KV v2 — autoDetect:false (default) — zero behavior change
    // -------------------------------------------------------------------------
    describe('KV v2 — autoDetect:false (default passthrough)', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts());
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('read() passes path through unchanged and wraps in Lease', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ request_id: 'r', data: { k: 'v' } }) };
            return client.read('secret/x').then((lease) => {
                expect(lease).to.be.instanceOf(Lease);
                expect(lease.getData()).to.deep.equal({ k: 'v' });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/x', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('write() passes path and data through unchanged', function () {
            const response = { data: { version: 1 } };
            client.__api = { makeRequest: sinon.stub().resolves(response) };
            return client.write('secret/x', { a: 1 }).then((res) => {
                expect(res).to.equal(response);
                expect(client.__api.makeRequest).to.have.been.calledWith('POST', 'secret/x', { a: 1 }, { 'X-Vault-Token': 'tid' });
            });
        });

        it('list() passes path through unchanged', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { keys: ['a'] } }) };
            return client.list('secret').then((lease) => {
                expect(lease).to.be.instanceOf(Lease);
                expect(client.__api.makeRequest).to.have.been.calledWith('LIST', 'secret', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('does NOT call sys/internal/ui/mounts when resolver is disabled', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { k: 'v' } }) };
            return client.read('secret/x').then(() => {
                // Should have called makeRequest exactly once (the actual read), not the detection endpoint
                expect(client.__api.makeRequest).to.have.been.calledOnce;
                const [, path] = client.__api.makeRequest.getCall(0).args;
                expect(path).to.not.include('sys/internal');
            });
        });

        it('list() preserves trailing slash on the wire (regression: byte-for-byte passthrough)', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { keys: ['a'] } }) };
            return client.list('secret/').then(() => {
                // Trailing slash must be preserved — wire path must match caller's path exactly
                expect(client.__api.makeRequest).to.have.been.calledWith('LIST', 'secret/', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('read() preserves trailing slash on the wire (regression: byte-for-byte passthrough)', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { k: 'v' } }) };
            return client.read('path/').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'path/', null, { 'X-Vault-Token': 'tid' });
            });
        });
    });

    // -------------------------------------------------------------------------
    // KV v2 — autoDetect:true — path rewriting + response unwrapping
    // -------------------------------------------------------------------------
    describe('KV v2 — autoDetect:true', function () {
        let client;
        const token = { getId: () => 'tid' };

        function bootV2Client() {
            return new VaultClient(bootOpts({
                api: { kv: { autoDetect: true } },
            }));
        }

        // Stub the resolver so we control version without real HTTP
        function stubResolver(c, version) {
            c.__resolver = new MountResolver(
                sinon.stub().resolves({
                    data: { path: 'secret/', type: 'kv', options: { version: String(version) } },
                }),
                {},
                { debug: _.noop, error: _.noop, info: _.noop, warn: _.noop, trace: _.noop }
            );
        }

        beforeEach(function () {
            client = bootV2Client();
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('read() rewrites path to data/ segment on v2', function () {
            stubResolver(client, 2);
            client.__api = { makeRequest: sinon.stub().resolves({
                data: { data: { username: 'admin' }, metadata: { version: 1 } },
            }) };
            return client.read('secret/foo').then((lease) => {
                expect(lease).to.be.instanceOf(Lease);
                expect(lease.getData()).to.deep.equal({ username: 'admin' });
                expect(lease.getMetadata()).to.deep.equal({ version: 1 });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/data/foo', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('write() wraps data in { data } and rewrites path on v2', function () {
            stubResolver(client, 2);
            client.__api = { makeRequest: sinon.stub().resolves({ data: { version: 3 } }) };
            return client.write('secret/foo', { password: 'pw' }).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/data/foo', { data: { password: 'pw' } }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('list() rewrites path to metadata/ segment on v2', function () {
            stubResolver(client, 2);
            client.__api = { makeRequest: sinon.stub().resolves({ data: { keys: ['foo', 'bar/'] } }) };
            return client.list('secret').then((lease) => {
                expect(client.__api.makeRequest).to.have.been.calledWith('LIST', 'secret/metadata/', null, { 'X-Vault-Token': 'tid' });
                expect(lease.getData()).to.deep.equal({ keys: ['foo', 'bar/'] });
            });
        });

        it('delete() sends DELETE to data/ path on v2', function () {
            stubResolver(client, 2);
            client.__api = { makeRequest: sinon.stub().resolves(null) };
            return client.delete('secret/foo').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('DELETE', 'secret/data/foo', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('read() passthrough on v1 mount (no path rewriting)', function () {
            // Stub resolver to return v1 for the 'secret' mount prefix
            client.__resolver = new MountResolver(
                sinon.stub().resolves({
                    data: { path: 'secret/', type: 'kv', options: { version: '1' } },
                }),
                {},
                { debug: _.noop, error: _.noop, info: _.noop, warn: _.noop, trace: _.noop }
            );
            client.__api = { makeRequest: sinon.stub().resolves({ data: { k: 'v' } }) };
            return client.read('secret/foo').then((lease) => {
                expect(lease.getData()).to.deep.equal({ k: 'v' });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/foo', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('Lease.getMetadata() returns undefined for v1 (no metadata in response)', function () {
            client.__resolver = new MountResolver(
                sinon.stub().resolves({
                    data: { path: 'secret/', type: 'kv', options: { version: '1' } },
                }),
                {},
                { debug: _.noop, error: _.noop, info: _.noop, warn: _.noop, trace: _.noop }
            );
            client.__api = { makeRequest: sinon.stub().resolves({ data: { k: 'v' } }) };
            return client.read('secret/foo').then((lease) => {
                expect(lease.getMetadata()).to.equal(undefined);
            });
        });
    });

    // -------------------------------------------------------------------------
    // KV v2 — engines override
    // -------------------------------------------------------------------------
    describe('KV v2 — engines override (no autoDetect)', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts({
                api: { engines: { secret: 2, legacy: 1 } },
            }));
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('uses engines override to rewrite path without detection', function () {
            client.__api = { makeRequest: sinon.stub().resolves({
                data: { data: { x: 1 }, metadata: { version: 1 } },
            }) };
            return client.read('secret/foo').then((lease) => {
                expect(lease.getData()).to.deep.equal({ x: 1 });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/data/foo', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('legacy mount (v1) passes through unchanged', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { a: 'b' } }) };
            return client.read('legacy/bar').then((lease) => {
                expect(lease.getData()).to.deep.equal({ a: 'b' });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'legacy/bar', null, { 'X-Vault-Token': 'tid' });
            });
        });
    });

    // -------------------------------------------------------------------------
    // request() — raw passthrough
    // -------------------------------------------------------------------------
    describe('#request()', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts());
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('sends the literal path and returns the parsed body', function () {
            const body = { ciphertext: 'vault:v1:xyz' };
            client.__api = { makeRequest: sinon.stub().resolves(body) };
            return client.request('POST', 'transit/encrypt/mykey', { plaintext: 'dGVzdA==' }).then((res) => {
                expect(res).to.equal(body);
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'transit/encrypt/mykey', { plaintext: 'dGVzdA==' }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('passes null when data is omitted', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.request('GET', 'sys/health').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'sys/health', null, { 'X-Vault-Token': 'tid' });
            });
        });
    });

    // -------------------------------------------------------------------------
    // update() — PATCH with merge-patch+json
    // -------------------------------------------------------------------------
    describe('#update()', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts({
                api: { engines: { secret: 2 } },
            }));
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('sends PATCH with application/merge-patch+json and data envelope on v2', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { version: 4 } }) };
            return client.update('secret/foo', { password: 'new' }).then(() => {
                const [method, path, data, headers] = client.__api.makeRequest.getCall(0).args;
                expect(method).to.equal('PATCH');
                expect(path).to.equal('secret/data/foo');
                expect(data).to.deep.equal({ data: { password: 'new' } });
                expect(headers['Content-Type']).to.equal('application/merge-patch+json');
            });
        });
    });

    // -------------------------------------------------------------------------
    // v2-only helpers
    // -------------------------------------------------------------------------
    describe('v2-only helpers', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts({
                api: { engines: { secret: 2 } },
            }));
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('deleteVersions() sends POST to delete/ path with versions body', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.deleteVersions('secret/foo', [1, 2]).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/delete/foo', { versions: [1, 2] }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('undeleteVersions() sends POST to undelete/ path', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.undeleteVersions('secret/foo', [1]).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/undelete/foo', { versions: [1] }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('destroyVersions() sends POST to destroy/ path', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.destroyVersions('secret/foo', [3]).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/destroy/foo', { versions: [3] }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('readMetadata() sends GET to metadata/ path and normalises response', function () {
            client.__api = { makeRequest: sinon.stub().resolves({
                request_id: 'r',
                data: { current_version: 2, versions: { '1': {}, '2': {} } },
            }) };
            return client.readMetadata('secret/foo').then((body) => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'GET', 'secret/metadata/foo', null, { 'X-Vault-Token': 'tid' }
                );
                expect(body.data).to.deep.equal({ current_version: 2, versions: { '1': {}, '2': {} } });
            });
        });

        it('deleteMetadata() sends DELETE to metadata/ path', function () {
            client.__api = { makeRequest: sinon.stub().resolves(null) };
            return client.deleteMetadata('secret/foo').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'DELETE', 'secret/metadata/foo', null, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('v2-only helpers throw UnsupportedOperationError on a v1 mount', function () {
            const v1Client = new VaultClient(bootOpts({
                api: { engines: { secret: 1 } },
            }));
            v1Client.__auth = { getAuthToken: sinon.stub().resolves(token) };
            v1Client.__api = { makeRequest: sinon.stub().resolves({}) };

            return v1Client.deleteVersions('secret/foo', [1]).then(
                () => { throw new Error('expected rejection'); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.UnsupportedOperationError);
                    expect(err.message).to.include('deleteVersions');
                }
            );
        });
    });
});
