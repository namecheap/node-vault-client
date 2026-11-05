/**
 * Generic-backend end-to-end suite (issue #222).
 *
 * Runs against the `vault-server` service from docker-compose.yml and covers what the unit and
 * mock tests can only assert against fakes: request() reaching a non-KV engine (transit), a
 * non-KV mount passing through under autoDetect, the in-flight detection dedupe under real
 * network latency, Lease.getMetadata() on a live KV v2 read, and mount detection with a
 * least-privilege token. The suite mounts its own engines under a per-run prefix and removes
 * them afterwards, so it needs nothing but the dev root token.
 *
 * Start the server with `docker compose up -d`, then `npm run test:e2e:generic`.
 */
import { expect } from 'chai';
import VaultClient from '../../src/VaultClient.js';
import errors from '../../src/errors.js';

const URL_BASE = 'http://127.0.0.1:8200/';
const ROOT_TOKEN = '8274d2a1-c80c-ff56-c6ed-1b99f7bcea78'; // see docker-compose.yml (vault-server)

// Unique per-run names: dev-mode Vault state survives between local runs against the same container.
const RUN = `e2e-gen-${Date.now().toString(36)}-${process.pid}`;
const TRANSIT = `transit-${RUN}`;
const KV2 = `kv2-${RUN}`;
const POLICY = `lp-${RUN}`;

const DETECTION = '/v1/sys/internal/ui/mounts/';

function newClient(token, opts) {
    return new VaultClient({
        api: Object.assign({ url: URL_BASE }, opts),
        logger: false,
        // The tokens here are short-lived test tokens; no renewal timer may outlive the suite.
        auth: { type: 'token', renewal: false, config: { token } },
    });
}

/**
 * Record the pathname of every request made through the global fetch until restore() runs.
 * With holdDetection, detection responses are held back until release(), and
 * detectionSent settles once the first detection request has been sent.
 */
function recordWire({ holdDetection = false } = {}) {
    const originalFetch = globalThis.fetch;
    const paths = [];
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let markSent;
    const detectionSent = new Promise((resolve) => { markSent = resolve; });
    globalThis.fetch = (input, options) => {
        const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
        const pathname = new URL(url).pathname;
        paths.push(pathname);
        const response = originalFetch.call(globalThis, input, options);
        if (!pathname.startsWith(DETECTION)) {
            return response;
        }
        markSent();
        return holdDetection ? response.then((res) => released.then(() => res)) : response;
    };
    return {
        paths,
        detectionSent,
        release,
        detections: () => paths.filter((p) => p.startsWith(DETECTION)),
        restore: () => {
            release();
            globalThis.fetch = originalFetch;
        },
    };
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('E2E generic backends', function () {
    // Each test is a handful of local round-trips; mount setup is the slowest part.
    this.timeout(15000);

    let admin;

    before(async function () {
        admin = newClient(ROOT_TOKEN);
        await admin.request('POST', `sys/mounts/${TRANSIT}`, { type: 'transit' });
        await admin.request('POST', `sys/mounts/${KV2}`, { type: 'kv', options: { version: '2' } });
        await admin.request('POST', `${TRANSIT}/keys/k`, {});
    });

    after(async function () {
        // Best effort: a failed setup must not hide the original error behind a teardown one.
        for (const path of [`sys/mounts/${TRANSIT}`, `sys/mounts/${KV2}`, `sys/policies/acl/${POLICY}`]) {
            await admin.request('DELETE', path).catch(() => {});
        }
    });

    describe('request() on a non-KV engine (transit)', function () {
        it('round-trips encrypt/decrypt through the literal path and returns the parsed body', async function () {
            const client = newClient(ROOT_TOKEN);
            const plaintext = b64('generic backend payload');

            const enc = await client.request('POST', `${TRANSIT}/encrypt/k`, { plaintext });
            expect(enc.data.ciphertext).to.match(/^vault:v1:/);

            const dec = await client.request('POST', `/${TRANSIT}/decrypt/k`, { ciphertext: enc.data.ciphertext });
            expect(dec.data.plaintext).to.equal(plaintext);
        });

        it('issues no detection request even with autoDetect on', async function () {
            const client = newClient(ROOT_TOKEN, { kv: { autoDetect: true } });
            const wire = recordWire();
            try {
                const enc = await client.request('POST', `${TRANSIT}/encrypt/k`, { plaintext: b64('x') });
                await client.request('POST', `${TRANSIT}/decrypt/k`, { ciphertext: enc.data.ciphertext });
                await client.request('GET', `${TRANSIT}/keys/k`);
            } finally {
                wire.restore();
            }
            expect(wire.detections()).to.deep.equal([]);
            expect(wire.paths.filter((p) => p.startsWith(`/v1/${TRANSIT}/`))).to.deep.equal([
                `/v1/${TRANSIT}/encrypt/k`,
                `/v1/${TRANSIT}/decrypt/k`,
                `/v1/${TRANSIT}/keys/k`,
            ]);
        });
    });

    describe('a non-KV mount under autoDetect', function () {
        it('is detected as passthrough: no data/ segment and no { data } envelope', async function () {
            const client = newClient(ROOT_TOKEN, { kv: { autoDetect: true } });
            const plaintext = b64('passthrough');
            const wire = recordWire();
            let enc;
            let dec;
            let key;
            try {
                // write() wraps the body in { data } only on KV v2; transit would answer 400
                // "missing plaintext" to a wrapped body, so the round-trip itself proves the
                // body went out as given.
                enc = await client.write(`${TRANSIT}/encrypt/k`, { plaintext });
                dec = await client.write(`${TRANSIT}/decrypt/k`, { ciphertext: enc.data.ciphertext });
                key = await client.read(`${TRANSIT}/keys/k`);
            } finally {
                wire.restore();
            }
            expect(dec.data.plaintext).to.equal(plaintext);
            expect(key.getData().name).to.equal('k');
            expect(key.getMetadata()).to.equal(undefined);

            expect(wire.detections()).to.have.lengthOf(1);
            expect(wire.paths.filter((p) => !p.startsWith(DETECTION) && p.includes(TRANSIT))).to.deep.equal([
                `/v1/${TRANSIT}/encrypt/k`,
                `/v1/${TRANSIT}/decrypt/k`,
                `/v1/${TRANSIT}/keys/k`,
            ]);
        });

        it('makes the KV v2 helpers throw UnsupportedOperationError without reaching the mount', async function () {
            const client = newClient(ROOT_TOKEN, { kv: { autoDetect: true } });
            const wire = recordWire();
            const failures = [];
            try {
                for (const call of [
                    () => client.readMetadata(`${TRANSIT}/keys/k`),
                    () => client.deleteMetadata(`${TRANSIT}/keys/k`),
                    () => client.deleteVersions(`${TRANSIT}/keys/k`, [1]),
                    () => client.undeleteVersions(`${TRANSIT}/keys/k`, [1]),
                    () => client.destroyVersions(`${TRANSIT}/keys/k`, [1]),
                ]) {
                    failures.push(await call().then(() => null, (err) => err));
                }
            } finally {
                wire.restore();
            }
            failures.forEach((err) => expect(err).to.be.instanceOf(errors.UnsupportedOperationError));
            // Refused because detection classified transit, not because no detection ran (with
            // autoDetect off every unlisted mount is v1 and throws the same error).
            expect(wire.detections()).to.deep.equal([`${DETECTION}${TRANSIT}/keys/k`]);
            expect(wire.paths.filter((p) => p.startsWith(`/v1/${TRANSIT}/`))).to.deep.equal([]);
            // The key is still there: deleteMetadata() did not reach transit's own DELETE keys/k.
            expect((await admin.request('GET', `${TRANSIT}/keys/k`)).data.name).to.equal('k');
        });
    });

    describe('mount detection on the wire', function () {
        it('sends exactly one detection request for reads that start while it is on the wire, then serves from cache', async function () {
            const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
            // Seeded through request(), which never detects, so the client below starts cold.
            for (const k of keys) {
                await admin.request('POST', `${KV2}/data/dedupe/${k}`, { data: { k } });
            }
            const client = newClient(ROOT_TOKEN, { kv: { autoDetect: true } });
            const wire = recordWire({ holdDetection: true });
            let leases;
            try {
                // Reads started together all join in the same microtask burst, before the first
                // detection is even sent. The other five start a few event-loop turns after it
                // is on the wire, and its response is held until they have reached the resolver.
                const first = client.read(`${KV2}/dedupe/${keys[0]}`);
                await wire.detectionSent;
                await delay(10);
                const rest = keys.slice(1).map((k) => client.read(`${KV2}/dedupe/${k}`));
                await delay(50);
                wire.release();
                leases = await Promise.all([first, ...rest]);
                expect(wire.detections()).to.have.lengthOf(1);

                await client.read(`${KV2}/dedupe/a`);
                await client.list(`${KV2}/dedupe`);
            } finally {
                wire.restore();
            }
            expect(leases.map((lease) => lease.getData())).to.deep.equal(keys.map((k) => ({ k })));
            expect(wire.detections()).to.have.lengthOf(1);
            expect(wire.paths.filter((p) => p.startsWith(`/v1/${KV2}/`))).to.have.members([
                ...keys.map((k) => `/v1/${KV2}/data/dedupe/${k}`),
                `/v1/${KV2}/data/dedupe/a`,
                `/v1/${KV2}/metadata/dedupe`,
            ]);
        });
    });

    describe('Lease.getMetadata()', function () {
        it('returns the live version metadata of a KV v2 read', async function () {
            const client = newClient(ROOT_TOKEN, { kv: { autoDetect: true } });
            const path = `${KV2}/meta/key`;
            await client.write(path, { v: 1 });
            await client.write(path, { v: 2 });

            const lease = await client.read(path);
            expect(lease.getData()).to.deep.equal({ v: 2 });

            const metadata = lease.getMetadata();
            const raw = await admin.request('GET', `${KV2}/data/meta/key`);
            expect(metadata).to.deep.equal(raw.data.metadata);
            expect(metadata.version).to.equal(2);
            expect(metadata.destroyed).to.equal(false);
            expect(metadata.deletion_time).to.equal('');
            expect(Date.parse(metadata.created_time)).to.be.a('number').and.not.NaN;
        });
    });

    describe('least-privilege token', function () {
        let token;

        before(async function () {
            await admin.request('POST', `${KV2}/data/lp/secret`, { data: { scoped: true } });
            // Only `read` on one key. The token keeps the default policy, which token auth
            // needs for lookup-self, and which grants nothing on sys/mounts or this mount.
            await admin.request('PUT', `sys/policies/acl/${POLICY}`, {
                policy: `path "${KV2}/data/lp/secret" { capabilities = ["read"] }`,
            });
            token = (await admin.request('POST', 'auth/token/create', { policies: [POLICY], ttl: '10m' })).auth.client_token;
        });

        after(async function () {
            if (token) {
                await admin.request('POST', 'auth/token/revoke', { token }).catch(() => {});
            }
        });

        it('auto-detects the KV v2 mount and reads, while sys/mounts is denied', async function () {
            const client = newClient(token, { kv: { autoDetect: true } });

            // Sanity check that the token really is restricted: the broad mount listing the
            // detection deliberately avoids is forbidden.
            const denied = await client.request('GET', 'sys/mounts').then(() => null, (err) => err);
            expect(denied).to.be.instanceOf(errors.VaultHttpError);
            expect(denied.statusCode).to.equal(403);

            const wire = recordWire();
            let lease;
            try {
                lease = await client.read(`${KV2}/lp/secret`);
            } finally {
                wire.restore();
            }
            expect(lease.getData()).to.deep.equal({ scoped: true });
            expect(lease.getMetadata().version).to.equal(1);
            // One detection, answered 200 (a denied one rejects the read with a VaultError),
            // and the read went to the rewritten data/ path, the only one the policy allows.
            expect(wire.detections()).to.deep.equal([`${DETECTION}${KV2}/lp/secret`]);
            expect(wire.paths.filter((p) => !p.startsWith(DETECTION))).to.deep.equal([`/v1/${KV2}/data/lp/secret`]);
        });
    });
});
