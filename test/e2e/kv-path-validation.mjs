/**
 * KV path validation end-to-end cases (GHSA-rr65-m54w-rfr9), shared by e2e.test.mjs (KV v1
 * server) and e2e.kv2.test.mjs (KV v2 server).
 *
 * The client runs with a non-root token whose policy covers every tenant under one prefix,
 * which is how a multi-tenant service is usually set up: Vault allows a cross-tenant request,
 * so the path the client sends is the only thing keeping tenants apart.
 */
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { expect, use } from 'chai';
import VaultClient from '../../src/VaultClient.js';
import errors from '../../src/errors.js';

use(sinonChai);

const KV_CALLS = [
    ['read', (c, p) => c.read(p)],
    ['list', (c, p) => c.list(p)],
    ['write', (c, p) => c.write(p, { owner: 'attacker' })],
    ['delete', (c, p) => c.delete(p)],
    ['update', (c, p) => c.update(p, { owner: 'attacker' })],
    ['deleteVersions', (c, p) => c.deleteVersions(p, [1])],
    ['undeleteVersions', (c, p) => c.undeleteVersions(p, [1])],
    ['destroyVersions', (c, p) => c.destroyVersions(p, [1])],
    ['readMetadata', (c, p) => c.readMetadata(p)],
    ['deleteMetadata', (c, p) => c.deleteMetadata(p)],
];

// Suffixes appended to `secret/<run>/tenants/`, as if the caller interpolated a tenant id.
const UNSAFE_TAILS = [
    ['a ".." segment', 'me/../victim/key'],
    ['".." out of the mount', 'me/../../../../sys/policies/acl/x'],
    ['a trailing ".."', 'me/..'],
    ['a "." segment', 'me/./key'],
    ['"%2e%2e"', 'me/%2e%2e/victim/key'],
    ['".%2e"', 'me/.%2e/victim/key'],
    ['"..%2f"', 'me/..%2fvictim%2fkey'],
    ['"..%2f" behind an invalid escape', 'me/..%2fvictim%2fkey%2f%ff%2f..'],
    ['"..%5c"', 'me/..%5cvictim/key'],
    ['a backslash', 'me/..\\victim/key'],
    ['a tab inside ".."', 'me/.\t./victim/key'],
    ['a line feed inside ".."', 'me/.\n./victim/key'],
    ['a carriage return inside ".."', 'me/.\r./victim/key'],
    ['".." with a trailing space', 'me/.. '],
    ['".." with a trailing C0 control', 'me/..\u0001'],
    ['a NUL', 'me/key\u0000'],
    ['a DEL', 'me/key\u007f'],
    ['a "#" that cuts the suffix', 'victim/key#/key'],
    ['a "?" that cuts the suffix', 'victim/key?/key'],
    ['an empty segment', '/key'],
    ['an empty segment before a trailing slash', '/'],
    ['an encoded empty segment', '%2F/key'],
    ['"%2f%2f"', 'x%2f%2fkey'],
    ['an unpaired surrogate', 'me/\ud800/key'],
];

// [label, key under secret/<run>/safe/, name list() returns for it]
const SAFE_KEYS = [
    ['upper case and underscores', 'MyApp/DB_PASSWORD', 'DB_PASSWORD'],
    ['a dot inside a segment', 'a.b/c', 'c'],
    ['".." inside a segment', 'a..b', 'a..b'],
    ['a leading dot', '.hidden', '.hidden'],
    ['three dots', '...', '...'],
    ['an inner space', 'my key', 'my key'],
    ['"@"', 'users/alice@example.com', 'alice@example.com'],
    ['non-ASCII', 'ключ/ünï', 'ünï'],
    ['percent-encoded "?" and "#"', 'k%3Fv%23w', 'k?v#w'],
    ['".." next to an escape', '..%20x', '.. x'],
];

/**
 * @param {Object} server
 * @param {string} server.url       - Vault address
 * @param {string} server.rootToken - dev-mode root token, used only for setup and checks
 * @param {number} server.kvVersion - version of the `secret/` mount on that server
 */
export function describeKvPathValidation({ url, rootToken, kvVersion }) {
    describe('KV path validation (GHSA-rr65-m54w-rfr9)', function () {
        this.timeout(15000);

        // Unique per run: dev-mode state survives between local runs against one container.
        const RUN = `e2e-ghsa-rr65-${Date.now().toString(36)}-${process.pid}`;
        const tenants = `secret/${RUN}/tenants`;
        const v2 = kvVersion === 2;
        // Literal API path for request(), which does no KV rewriting.
        const apiPath = (path) => (v2 ? path.replace(/^secret\//, 'secret/data/') : path);
        const dataOf = (body) => (v2 ? body.data.data : body.data);

        const newClient = (token) => new VaultClient({
            api: { url, kv: { autoDetect: true } },
            logger: false,
            auth: { type: 'token', config: { token } },
        });

        let admin;
        let service;
        let serviceToken;

        before(async function () {
            admin = newClient(rootToken);
            const prefixes = v2
                ? ['data', 'metadata', 'delete', 'undelete', 'destroy'].map((segment) => `secret/${segment}/${RUN}/*`)
                : [`secret/${RUN}/*`];
            const policy = prefixes
                .map((prefix) => `path "${prefix}" { capabilities = ["create", "read", "update", "patch", "delete", "list"] }`)
                .join('\n');
            await admin.request('PUT', `sys/policies/acl/${RUN}`, { policy });
            serviceToken = (await admin.request('POST', 'auth/token/create', { policies: [RUN], ttl: '1h' })).auth.client_token;
            service = newClient(serviceToken);

            await admin.write(`${tenants}/victim/key`, { owner: 'victim' });
            await admin.write(`${tenants}/me/key`, { owner: 'me' });
            await admin.write(`${tenants}/key`, { owner: 'parent' });
            // A key named like the tenant folder, for the trailing-slash case.
            await admin.write(`${tenants}/me`, { owner: 'me-folder-key' });
        });

        // These pin the fetch() and Vault behaviour that makes the rejected paths dangerous, so
        // the rejections below are not vacuous: request() sends its path unvalidated.
        describe('the same paths sent unvalidated through request()', function () {
            [
                ['a ".." segment', 'me/../victim/key'],
                ['"%2e%2e"', 'me/%2e%2e/victim/key'],
                ['a backslash', 'me/..\\victim/key'],
                ['a tab inside ".."', 'me/.\t./victim/key'],
                ['a "#" that cuts the suffix', 'victim/key#/key'],
                ['a "?" that cuts the suffix', 'victim/key?/key'],
            ].forEach(([label, tail]) => {
                it(`${label} reads another tenant's secret`, async function () {
                    const body = await service.request('GET', apiPath(`${tenants}/${tail}`));
                    expect(dataOf(body)).to.deep.equal({ owner: 'victim' });
                });
            });

            it('an empty segment reads the parent key: Vault redirects "//" to the collapsed path', async function () {
                const body = await service.request('GET', apiPath(`${tenants}//key`));
                expect(dataOf(body)).to.deep.equal({ owner: 'parent' });
            });

            it('an empty segment sends a write to the parent key', async function () {
                // Its own parent key, so the untouched check below is not affected.
                const parent = `secret/${RUN}/redirect/key`;
                await admin.write(parent, { owner: 'parent' });
                const data = v2 ? { data: { owner: 'attacker' } } : { owner: 'attacker' };

                const body = await service.request('POST', apiPath(`secret/${RUN}/redirect//key`), data);

                // Vault 1.x redirects with a 301, which fetch() replays as a GET without the body:
                // the "write" returns the parent's secret. Vault 2.x redirects with a 307, which
                // keeps the POST: the write overwrites the parent.
                const stored = (await admin.read(parent)).getData();
                const returnedParent = Boolean(body && dataOf(body) && dataOf(body).owner === 'parent');
                expect(stored.owner === 'attacker' || returnedParent, JSON.stringify({ body, stored })).to.equal(true);
            });

            if (v2) {
                it('a trailing slash on a metadata call addresses the parent key', async function () {
                    const body = await service.request('GET', `secret/metadata/${RUN}/tenants/me/`);
                    const parent = await admin.readMetadata(`${tenants}/me`);
                    expect(body.data.created_time).to.equal(parent.data.created_time);
                });
            }
        });

        describe('KV methods', function () {
            let fetchSpy;

            beforeEach(function () {
                // Pass-through spy: every request still reaches the real server.
                fetchSpy = sinon.spy(globalThis, 'fetch');
            });

            afterEach(function () {
                fetchSpy.restore();
            });

            UNSAFE_TAILS.forEach(([label, tail]) => {
                it(`reject ${label} on every method without sending a request`, async function () {
                    // A fresh client: the token lookup and the autoDetect detection request
                    // would show up in `fetchSpy` too.
                    const client = newClient(serviceToken);
                    const path = `${tenants}/${tail}`;
                    const outcomes = [];
                    for (const [method, call] of KV_CALLS) {
                        outcomes.push([method, await call(client, path).then(() => 'resolved', (err) => err)]);
                    }
                    outcomes.forEach(([method, outcome]) => {
                        expect(outcome, method).to.be.instanceOf(errors.InvalidArgumentsError);
                        expect(outcome.message, method).to.match(/^Invalid secret path: /);
                        expect(outcome.message, method).to.not.include(RUN);
                    });
                    expect(fetchSpy).to.not.have.been.called;
                });
            });

            it('reject a trailing slash on the KV v2 helpers without sending a request', async function () {
                const client = newClient(serviceToken);
                const helpers = KV_CALLS.filter(([method]) => /Versions$|Metadata$/.test(method));
                for (const [method, call] of helpers) {
                    const outcome = await call(client, `${tenants}/me/`).then(() => 'resolved', (err) => err);
                    expect(outcome, method).to.be.instanceOf(errors.InvalidArgumentsError);
                }
                expect(fetchSpy).to.not.have.been.called;
            });

            it('pass a trailing slash on the data methods through without reaching the parent key', async function () {
                // Vault answers 400/404 here, unlike the metadata calls; the untouched check
                // below confirms the key 'tenants/me' survives.
                const calls = [
                    service.read(`${tenants}/me/`),
                    service.write(`${tenants}/me/`, { owner: 'attacker' }),
                    service.update(`${tenants}/me/`, { owner: 'attacker' }),
                    service.delete(`${tenants}/me/`),
                ];
                for (const outcome of await Promise.allSettled(calls)) {
                    if (outcome.status === 'rejected') {
                        expect(outcome.reason).to.be.instanceOf(errors.VaultHttpError);
                    }
                }
            });

            it('leave every tenant\'s secret untouched', async function () {
                const seeded = [['victim/key', 'victim'], ['me/key', 'me'], ['key', 'parent'], ['me', 'me-folder-key']];
                for (const [key, owner] of seeded) {
                    expect((await admin.read(`${tenants}/${key}`)).getData(), key).to.deep.equal({ owner });
                    if (v2) {
                        const meta = await admin.readMetadata(`${tenants}/${key}`);
                        expect(meta.data.current_version, key).to.equal(1);
                        expect(meta.data.versions['1'], key).to.include({ deletion_time: '', destroyed: false });
                    }
                }
            });

            // KV v1 itself refuses any key containing '..' ("relative paths not supported"),
            // with or without this client; KV v2 stores them.
            const safeKeys = v2 ? SAFE_KEYS : SAFE_KEYS.filter(([, key]) => !decodeURIComponent(key).includes('..'));
            safeKeys.forEach(([label, key, listed]) => {
                it(`still write, read, list and delete a key with ${label}`, async function () {
                    const path = `secret/${RUN}/safe/${key}`;
                    const folder = path.slice(0, path.lastIndexOf('/') + 1);

                    await service.write(path, { label });
                    expect((await service.read(path)).getData()).to.deep.equal({ label });
                    expect((await service.list(folder)).getData().keys).to.include(listed);

                    await service.delete(path);
                    const err = await service.read(path).then(() => null, (e) => e);
                    expect(err).to.be.instanceOf(errors.VaultHttpError);
                    expect(err.statusCode).to.equal(404);
                });
            });

            it('still accept a leading slash, on the key it names', async function () {
                // KV v2 used to rewrite '/secret/x' to 'secret/data//secret/x', which Vault
                // redirects to the key 'secret/x' inside the 'secret' mount.
                await service.write(`/secret/${RUN}/safe/leading`, { leading: true });
                expect((await service.read(`secret/${RUN}/safe/leading`)).getData()).to.deep.equal({ leading: true });
                expect((await service.read(`//secret/${RUN}/safe/leading`)).getData()).to.deep.equal({ leading: true });
            });

            it('reject a percent-encoded mount in every mode without sending a request', async function () {
                // A decoy where the old KV v2 rewrite landed; admin clients, so ACLs play no part.
                await admin.write(`secret/secret/${RUN}/tenants/me/key`, { owner: 'decoy' });
                fetchSpy.resetHistory();
                const engines = new VaultClient({
                    api: { url, kv: { autoDetect: false }, engines: { secret: kvVersion } },
                    logger: false,
                    auth: { type: 'token', config: { token: rootToken } },
                });
                for (const client of [newClient(rootToken), engines]) {
                    for (const path of [`secre%74/${RUN}/tenants/me/key`, `secret%2f${RUN}/tenants/me/key`]) {
                        const outcome = await client.read(path).then((lease) => lease.getData(), (err) => err);
                        expect(outcome, path).to.be.instanceOf(errors.InvalidArgumentsError);
                    }
                }
                expect(fetchSpy).to.not.have.been.called;
            });
        });
    });
}
