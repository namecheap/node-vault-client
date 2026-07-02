/**
 * KV v2 end-to-end suite (issue #107).
 *
 * Runs against the `vault-server-kv2` service from docker-compose.yml — a dev-mode
 * Vault that mounts `secret/` as KV v2 — and exercises the whole v2 feature area
 * that is otherwise only unit/mock-tested: mount auto-detection, data/metadata
 * path rewriting, merge-patch update, version operations and metadata operations.
 *
 * Start the server with `docker compose up -d`, then `npm run test:e2e:kv2`.
 */
import deepFreeze from 'deep-freeze';
import _ from 'lodash';
import { expect } from 'chai';
import VaultClient from '../../src/VaultClient.js';
import errors from '../../src/errors.js';

// Unique per-run prefix: dev-mode Vault state survives between local runs of the
// suite against the same container, so version counters must not accumulate.
const RUN = `e2e-kv2-${Date.now().toString(36)}-${process.pid}`;

describe('E2E KV v2', function () {
    // Several tests perform a detection round-trip plus a handful of writes.
    this.timeout(15000);

    beforeEach(function () {
        this.bootOpts = deepFreeze({
            api: {
                url: 'http://127.0.0.1:8202/',
                kv: { autoDetect: true },
            },
            logger: false,
            auth: {
                type: 'token',
                config: {
                    token: '34c9c953-4ff5-368a-ac5c-a1e1a8e13a52', // see docker-compose.yml (vault-server-kv2)
                },
            },
        });
        this.client = new VaultClient(this.bootOpts);
    });

    describe('path rewriting + auto-detection', function () {
        it('writes and reads through the rewritten data/ path', async function () {
            const testData = { tst: 'testData', tstInt: 12345 };
            const path = `secret/${RUN}/rw`;

            const writeRes = await this.client.write(path, testData);
            // v2 write responses carry the created version in the envelope.
            expect(writeRes.data.version).to.equal(1);

            const res = await this.client.read(path);
            expect(res.getData()).to.deep.equal(testData);
        });

        it('actually stores the secret under <mount>/data/<path> on the server', async function () {
            const testData = { probe: 'wire-level' };
            const path = `secret/${RUN}/probe`;

            await this.client.write(path, testData);

            // Raw request bypasses all rewriting: the v2 envelope must exist at data/.
            const raw = await this.client.request('GET', `/secret/data/${RUN}/probe`);
            expect(raw.data.data).to.deep.equal(testData);
            expect(raw.data.metadata.version).to.equal(1);
        });

        it('lists keys through the rewritten metadata/ path', async function () {
            await this.client.write(`secret/${RUN}/list/a`, { v: 1 });
            await this.client.write(`secret/${RUN}/list/b`, { v: 2 });

            const list = await this.client.list(`secret/${RUN}/list`);
            expect(list.getData().keys.sort()).to.deep.equal(['a', 'b']);
        });

        it('honours an explicit engines override without auto-detection', async function () {
            const client = new VaultClient(_.merge({}, this.bootOpts, {
                api: { kv: { autoDetect: false }, engines: { secret: 2 } },
            }));
            const testData = { via: 'engines-override' };
            const path = `secret/${RUN}/engines`;

            await client.write(path, testData);
            const res = await client.read(path);
            expect(res.getData()).to.deep.equal(testData);
        });

        it('detects a KV v1 mount on the same server and passes paths through raw', async function () {
            const mount = `kv1-${RUN}`;
            await this.client.request('POST', `/sys/mounts/${mount}`, { type: 'kv', options: { version: '1' } });

            const testData = { engine: 'kv-v1' };
            await this.client.write(`${mount}/foo`, testData);

            const res = await this.client.read(`${mount}/foo`);
            expect(res.getData()).to.deep.equal(testData);

            // v1 stores at the literal path — no data/ segment.
            const raw = await this.client.request('GET', `/${mount}/foo`);
            expect(raw.data).to.deep.equal(testData);

            // v2-only helpers must refuse to run against it.
            try {
                await this.client.deleteVersions(`${mount}/foo`, [1]);
                throw new Error('expected UnsupportedOperationError');
            } catch (e) {
                expect(e).to.be.instanceOf(errors.UnsupportedOperationError);
            }
        });
    });

    describe('update (merge-patch)', function () {
        it('merges new fields into the existing secret and bumps the version', async function () {
            const path = `secret/${RUN}/patch`;
            await this.client.write(path, { keep: 'original', overwrite: 'old' });

            const patchRes = await this.client.update(path, { overwrite: 'new', added: 'yes' });
            expect(patchRes.data.version).to.equal(2);

            const res = await this.client.read(path);
            expect(res.getData()).to.deep.equal({ keep: 'original', overwrite: 'new', added: 'yes' });
        });
    });

    describe('delete + version operations', function () {
        it('delete() soft-deletes the latest version', async function () {
            const path = `secret/${RUN}/del`;
            await this.client.write(path, { v: 1 });

            await this.client.delete(path);

            // Reading a soft-deleted latest version yields 404 from Vault.
            try {
                await this.client.read(path);
                throw new Error('expected read of deleted secret to fail');
            } catch (e) {
                expect(e.statusCode).to.equal(404);
            }

            // ...but the version history survives in metadata.
            const meta = await this.client.readMetadata(path);
            expect(meta.data.versions['1'].deletion_time).to.not.equal('');
        });

        it('deleteVersions / undeleteVersions / destroyVersions drive per-version state', async function () {
            const path = `secret/${RUN}/versions`;
            await this.client.write(path, { rev: 1 });
            await this.client.write(path, { rev: 2 });

            // Soft-delete version 1 only: latest (2) must stay readable.
            await this.client.deleteVersions(path, [1]);
            let meta = await this.client.readMetadata(path);
            expect(meta.data.versions['1'].deletion_time).to.not.equal('');
            expect(meta.data.versions['2'].deletion_time).to.equal('');
            expect((await this.client.read(path)).getData()).to.deep.equal({ rev: 2 });

            // Undelete restores version 1.
            await this.client.undeleteVersions(path, [1]);
            meta = await this.client.readMetadata(path);
            expect(meta.data.versions['1'].deletion_time).to.equal('');

            // Destroy is permanent and flagged in metadata.
            await this.client.destroyVersions(path, [1]);
            meta = await this.client.readMetadata(path);
            expect(meta.data.versions['1'].destroyed).to.equal(true);
            expect(meta.data.versions['2'].destroyed).to.equal(false);
        });
    });

    describe('metadata operations', function () {
        it('readMetadata() exposes current_version and the versions map', async function () {
            const path = `secret/${RUN}/meta`;
            await this.client.write(path, { rev: 1 });
            await this.client.write(path, { rev: 2 });

            const meta = await this.client.readMetadata(path);
            expect(meta.data.current_version).to.equal(2);
            expect(Object.keys(meta.data.versions).sort()).to.deep.equal(['1', '2']);
        });

        it('deleteMetadata() permanently removes the secret and its history', async function () {
            const path = `secret/${RUN}/meta-del`;
            await this.client.write(path, { doomed: true });

            await this.client.deleteMetadata(path);

            try {
                await this.client.readMetadata(path);
                throw new Error('expected readMetadata of removed secret to fail');
            } catch (e) {
                expect(e.statusCode).to.equal(404);
            }
        });
    });
});
