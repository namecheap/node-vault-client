'use strict';

/**
 * Integration-style unit tests for the KV v2 awareness wired into VaultClient.
 *
 * The VaultApiClient.makeRequest and the auth provider's getAuthToken are stubbed,
 * so no real HTTP happens. These tests assert path rewriting, data wrapping and
 * response normalization for read/list/write across v1 (passthrough),
 * engines override and autoDetect.
 */

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const sinonChai = require('sinon-chai');

const VaultClient = require('../src/VaultClient');

chai.use(sinonChai);

const FAKE_TOKEN = { getId: () => 'test-token' };

function buildClient(apiOverrides) {
    const options = {
        api: Object.assign({ url: 'https://vault.example.com/' }, apiOverrides),
        logger: false,
        auth: {
            type: 'token',
            config: { token: 'XXXXXXXX-eb8e-5f25-fad2-79274fa13a64' },
        },
    };

    const client = new VaultClient(options);

    // Avoid any real auth network round-trip.
    sinon.stub(client.__auth, 'getAuthToken').resolves(FAKE_TOKEN);

    const makeRequest = sinon.stub(client.__api, 'makeRequest');
    return { client, makeRequest };
}

// Each test builds a fresh `new VaultClient`, so stubs live on per-test instances
// and need no global teardown (sinon 2 has no global sinon.restore()).
describe('VaultClient KV v2 awareness', function () {

    // -------------------------------------------------------------------------
    // Default (no kv config) — byte-for-byte passthrough (v1 behaviour)
    // -------------------------------------------------------------------------
    describe('default (no kv options) — passthrough', function () {
        it('read uses the literal path and never issues a detection call', async function () {
            const { client, makeRequest } = buildClient();
            makeRequest.resolves({ data: { foo: 'bar' } });

            const lease = await client.read('secret/app/cfg');

            expect(makeRequest).to.have.been.calledOnce;
            expect(makeRequest).to.have.been.calledWith('GET', 'secret/app/cfg', null);
            expect(lease.getData()).to.deep.equal({ foo: 'bar' });
        });

        it('write posts the raw data to the literal path (no { data } wrapping)', async function () {
            const { client, makeRequest } = buildClient();
            makeRequest.resolves({});

            await client.write('secret/app/cfg', { foo: 'bar' });

            expect(makeRequest).to.have.been.calledWith('POST', 'secret/app/cfg', { foo: 'bar' });
        });

        it('list uses the literal path', async function () {
            const { client, makeRequest } = buildClient();
            makeRequest.resolves({ data: { keys: ['a', 'b'] } });

            const lease = await client.list('secret');

            expect(makeRequest).to.have.been.calledWith('LIST', 'secret', null);
            expect(lease.getData()).to.deep.equal({ keys: ['a', 'b'] });
        });
    });

    // -------------------------------------------------------------------------
    // engines override (autoDetect off) — no detection call, version from map
    // -------------------------------------------------------------------------
    describe('engines override', function () {
        it('read rewrites to data/ and unwraps body.data.data + metadata for a v2 mount', async function () {
            const { client, makeRequest } = buildClient({ engines: { secret: 2 } });
            makeRequest.resolves({
                request_id: 'rid',
                data: {
                    data: { username: 'admin', password: 's3cr3t' },
                    metadata: { version: 4, created_time: '2024-01-01' },
                },
            });

            const lease = await client.read('secret/app/cfg');

            expect(makeRequest).to.have.been.calledOnce;
            expect(makeRequest).to.have.been.calledWith('GET', 'secret/data/app/cfg', null);
            expect(lease.getData()).to.deep.equal({ username: 'admin', password: 's3cr3t' });
            expect(lease.getMetadata()).to.deep.equal({ version: 4, created_time: '2024-01-01' });
        });

        it('write wraps data in { data } and targets data/ for a v2 mount', async function () {
            const { client, makeRequest } = buildClient({ engines: { secret: 2 } });
            makeRequest.resolves({ data: { version: 1 } });

            await client.write('secret/app/cfg', { foo: 'bar' });

            expect(makeRequest).to.have.been.calledWith('POST', 'secret/data/app/cfg', { data: { foo: 'bar' } });
        });

        it('list targets metadata/ for a v2 mount', async function () {
            const { client, makeRequest } = buildClient({ engines: { secret: 2 } });
            makeRequest.resolves({ data: { keys: ['app/'] } });

            const lease = await client.list('secret');

            expect(makeRequest).to.have.been.calledWith('LIST', 'secret/metadata/', null);
            expect(lease.getData()).to.deep.equal({ keys: ['app/'] });
        });

        it('a v1 engine override behaves as passthrough', async function () {
            const { client, makeRequest } = buildClient({ engines: { legacy: 1 } });
            makeRequest.resolves({ data: { foo: 'bar' } });

            await client.read('legacy/app/cfg');

            expect(makeRequest).to.have.been.calledWith('GET', 'legacy/app/cfg', null);
        });

        it('mounts not listed in engines stay passthrough and trigger no detection', async function () {
            const { client, makeRequest } = buildClient({ engines: { secret: 2 } });
            makeRequest.resolves({ data: { foo: 'bar' } });

            await client.read('other/app/cfg');

            expect(makeRequest).to.have.been.calledOnce;
            expect(makeRequest).to.have.been.calledWith('GET', 'other/app/cfg', null);
        });
    });

    // -------------------------------------------------------------------------
    // autoDetect — one sys/internal/ui/mounts round-trip, then the rewritten op
    // -------------------------------------------------------------------------
    describe('autoDetect', function () {
        it('detects a v2 mount, then reads from data/ and unwraps the payload', async function () {
            const { client, makeRequest } = buildClient({ kv: { autoDetect: true } });

            makeRequest
                .withArgs('GET', 'sys/internal/ui/mounts/secret/app/cfg')
                .resolves({ data: { path: 'secret/', type: 'kv', options: { version: '2' } } });
            makeRequest
                .withArgs('GET', 'secret/data/app/cfg')
                .resolves({ data: { data: { foo: 'bar' }, metadata: { version: 2 } } });

            const lease = await client.read('secret/app/cfg');

            expect(makeRequest).to.have.been.calledWith('GET', 'sys/internal/ui/mounts/secret/app/cfg');
            expect(makeRequest).to.have.been.calledWith('GET', 'secret/data/app/cfg', null);
            expect(lease.getData()).to.deep.equal({ foo: 'bar' });
            expect(lease.getMetadata()).to.deep.equal({ version: 2 });
        });

        it('detects a v1 mount and reads from the literal path', async function () {
            const { client, makeRequest } = buildClient({ kv: { autoDetect: true } });

            makeRequest
                .withArgs('GET', 'sys/internal/ui/mounts/kv1/app/cfg')
                .resolves({ data: { path: 'kv1/', type: 'kv', options: { version: '1' } } });
            makeRequest
                .withArgs('GET', 'kv1/app/cfg')
                .resolves({ data: { foo: 'bar' } });

            const lease = await client.read('kv1/app/cfg');

            expect(makeRequest).to.have.been.calledWith('GET', 'kv1/app/cfg', null);
            expect(lease.getData()).to.deep.equal({ foo: 'bar' });
        });

        it('caches detection — a second op on the same mount issues no new detection call', async function () {
            const { client, makeRequest } = buildClient({ kv: { autoDetect: true } });

            makeRequest
                .withArgs('GET', 'sys/internal/ui/mounts/secret/a')
                .resolves({ data: { path: 'secret/', type: 'kv', options: { version: '2' } } });
            makeRequest.resolves({ data: { data: { foo: 'bar' } } });

            await client.read('secret/a');
            await client.read('secret/b');

            const detectionCalls = makeRequest.getCalls()
                .filter((c) => c.args[1].startsWith('sys/internal/ui/mounts/'));
            expect(detectionCalls).to.have.length(1);
        });
    });
});
