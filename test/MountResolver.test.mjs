/**
 * Unit tests for MountResolver.
 * Uses a mock detectFn so no real HTTP is performed.
 */

import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import MountResolver from '../src/MountResolver.js';
import errors from '../src/errors.js';

use(sinonChai);

// Helper that builds a detection response for a given version
function mkDetect(mount, version, type = 'kv') {
    return Promise.resolve({
        data: {
            path: mount.endsWith('/') ? mount : mount + '/',
            type,
            options: { version: String(version) },
        },
    });
}

describe('MountResolver', function () {
    const logger = {
        debug: sinon.stub(),
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        trace: sinon.stub(),
    };

    beforeEach(function () {
        // Reset call counts between tests
        sinon.resetHistory();
    });

    // -------------------------------------------------------------------------
    // engines override — must skip detectFn entirely
    // -------------------------------------------------------------------------
    describe('engines override', function () {
        it('returns version from engines map without calling detectFn', async function () {
            const detectFn = sinon.stub().rejects(new Error('should not be called'));
            const resolver = new MountResolver(detectFn, { secret: 2, legacy: 1 }, logger);

            const result = await resolver.resolve('secret/foo');
            expect(detectFn).to.not.have.been.called;
            expect(result.version).to.equal(2);
            expect(result.mount).to.equal('secret');
        });

        it('returns version 1 for a v1 engine override', async function () {
            const detectFn = sinon.stub().rejects(new Error('should not be called'));
            const resolver = new MountResolver(detectFn, { legacy: 1 }, logger);

            const result = await resolver.resolve('legacy/path');
            expect(detectFn).to.not.have.been.called;
            expect(result.version).to.equal(1);
            expect(result.mount).to.equal('legacy');
        });

        it('longest-prefix wins when multiple engines match', async function () {
            const detectFn = sinon.stub().rejects(new Error('should not be called'));
            // "secret/team" is more specific than "secret"
            const resolver = new MountResolver(detectFn, { secret: 1, 'secret/team': 2 }, logger);

            const r1 = await resolver.resolve('secret/team/svc');
            expect(r1.version).to.equal(2);
            expect(r1.mount).to.equal('secret/team');

            const r2 = await resolver.resolve('secret/other/svc');
            expect(r2.version).to.equal(1);
            expect(r2.mount).to.equal('secret');
        });
    });

    // -------------------------------------------------------------------------
    // auto-detection via detectFn
    // -------------------------------------------------------------------------
    describe('auto-detection', function () {
        it('detects KV v2 by calling detectFn and returns correct result', async function () {
            const detectFn = sinon.stub().callsFake(() => mkDetect('secret', 2));
            const resolver = new MountResolver(detectFn, {}, logger);

            const result = await resolver.resolve('secret/foo');
            expect(detectFn).to.have.been.calledOnce;
            expect(result.version).to.equal(2);
            expect(result.mount).to.equal('secret');
            expect(result.type).to.equal('kv');
        });

        it('detects KV v1 by calling detectFn', async function () {
            const detectFn = sinon.stub().callsFake(() => mkDetect('kvv1', 1));
            const resolver = new MountResolver(detectFn, {}, logger);

            const result = await resolver.resolve('kvv1/foo');
            expect(result.version).to.equal(1);
            expect(result.mount).to.equal('kvv1');
        });

        it('detects non-kv mounts as passthrough (version 1)', async function () {
            const detectFn = sinon.stub().resolves({
                data: { path: 'transit/', type: 'transit', options: {} },
            });
            const resolver = new MountResolver(detectFn, {}, logger);

            const result = await resolver.resolve('transit/encrypt/key');
            expect(result.version).to.equal(1);
            expect(result.type).to.equal('transit');
        });
    });

    // -------------------------------------------------------------------------
    // caching — detectFn must be called only once per canonical mount
    // -------------------------------------------------------------------------
    describe('caching', function () {
        it('calls detectFn only once for the same mount', async function () {
            const detectFn = sinon.stub().callsFake(() => mkDetect('secret', 2));
            const resolver = new MountResolver(detectFn, {}, logger);

            await resolver.resolve('secret/foo');
            await resolver.resolve('secret/bar');
            await resolver.resolve('secret/baz');

            expect(detectFn).to.have.been.calledOnce;
        });

        it('caches independently for different mounts', async function () {
            const detectFn = sinon.stub().callsFake((p) => {
                if (p.startsWith('secret/')) return mkDetect('secret', 2);
                if (p.startsWith('legacy/')) return mkDetect('legacy', 1);
                return Promise.reject(new Error('unexpected'));
            });
            const resolver = new MountResolver(detectFn, {}, logger);

            const r1 = await resolver.resolve('secret/foo');
            const r2 = await resolver.resolve('legacy/bar');

            expect(detectFn).to.have.been.calledTwice;
            expect(r1.version).to.equal(2);
            expect(r2.version).to.equal(1);

            // Further calls must not re-detect
            await resolver.resolve('secret/baz');
            await resolver.resolve('legacy/qux');
            expect(detectFn).to.have.been.calledTwice;
        });
    });

    // -------------------------------------------------------------------------
    // in-flight dedupe — concurrent first-touch must only call detectFn once
    // -------------------------------------------------------------------------
    describe('in-flight dedupe', function () {
        it('does not issue concurrent detectFn calls for the same mount', async function () {
            let resolve;
            const pending = new Promise((res) => { resolve = res; });
            const detectFn = sinon.stub().callsFake(() =>
                pending.then(() => ({
                    data: { path: 'secret/', type: 'kv', options: { version: '2' } },
                }))
            );
            const resolver = new MountResolver(detectFn, {}, logger);

            // Fire three concurrent resolves before detection completes
            const p1 = resolver.resolve('secret/a');
            const p2 = resolver.resolve('secret/b');
            const p3 = resolver.resolve('secret/c');

            // Unblock the detection
            resolve();
            const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

            // detectFn must have been called exactly once
            expect(detectFn).to.have.been.calledOnce;
            expect(r1.version).to.equal(2);
            expect(r2.version).to.equal(2);
            expect(r3.version).to.equal(2);
        });

        it('concurrent resolutions of distinct multi-segment mounts sharing a first segment each get the correct version (regression)', async function () {
            // "team/kvA" is v2; "team/kvB" is v1.  Both share first segment "team".
            // Previously, interimKey = "team" for both, collapsing them into one detection call
            // and returning the wrong version for the second mount.
            let resolveA, resolveB;
            const pendingA = new Promise((res) => { resolveA = res; });
            const pendingB = new Promise((res) => { resolveB = res; });

            const detectFn = sinon.stub().callsFake((p) => {
                if (p.startsWith('team/kvA')) {
                    return pendingA.then(() => ({
                        data: { path: 'team/kvA/', type: 'kv', options: { version: '2' } },
                    }));
                }
                return pendingB.then(() => ({
                    data: { path: 'team/kvB/', type: 'kv', options: { version: '1' } },
                }));
            });

            const resolver = new MountResolver(detectFn, {}, logger);

            const pA = resolver.resolve('team/kvA/secret1');
            const pB = resolver.resolve('team/kvB/secret2');

            // Unblock both detections
            resolveA();
            resolveB();
            const [rA, rB] = await Promise.all([pA, pB]);

            // Each mount must resolve to its own correct version
            expect(rA.mount).to.equal('team/kvA');
            expect(rA.version).to.equal(2);
            expect(rB.mount).to.equal('team/kvB');
            expect(rB.version).to.equal(1);
        });
    });

    // -------------------------------------------------------------------------
    // failure handling
    // -------------------------------------------------------------------------
    describe('failure handling', function () {
        it('throws VaultError when detectFn rejects', async function () {
            const detectFn = sinon.stub().rejects(new Error('403 Forbidden'));
            const resolver = new MountResolver(detectFn, {}, logger);

            try {
                await resolver.resolve('secret/foo');
                throw new Error('expected rejection');
            } catch (err) {
                expect(err).to.be.instanceOf(errors.VaultError);
                expect(err.message).to.include('secret');
            }
        });

        it('clears the in-flight entry on failure so future calls retry', async function () {
            let callCount = 0;
            const detectFn = sinon.stub().callsFake(() => {
                callCount++;
                if (callCount === 1) return Promise.reject(new Error('transient'));
                return mkDetect('secret', 2);
            });
            const resolver = new MountResolver(detectFn, {}, logger);

            // First call fails
            await resolver.resolve('secret/foo').catch(() => {});

            // Second call should succeed (retry after failure)
            const result = await resolver.resolve('secret/foo');
            expect(result.version).to.equal(2);
            expect(detectFn).to.have.been.calledTwice;
        });
    });

    // -------------------------------------------------------------------------
    // longest-prefix detection with auto-detect
    // -------------------------------------------------------------------------
    describe('longest-prefix matching from detection response', function () {
        it('uses the canonical mount path from data.path for cache key', async function () {
            // Vault returns canonical path with trailing slash
            const detectFn = sinon.stub().resolves({
                data: { path: 'secret/', type: 'kv', options: { version: '2' } },
            });
            const resolver = new MountResolver(detectFn, {}, logger);

            await resolver.resolve('secret/foo');
            await resolver.resolve('secret/bar');

            expect(detectFn).to.have.been.calledOnce;
        });
    });

    // -------------------------------------------------------------------------
    // disabled resolver (no autoDetect, no engines)
    // -------------------------------------------------------------------------
    describe('disabled resolver', function () {
        it('resolve() returns passthrough (version 1) without calling detectFn when disabled', async function () {
            const detectFn = sinon.stub().rejects(new Error('should not be called'));
            const resolver = new MountResolver(detectFn, {}, logger, { disabled: true });

            const result = await resolver.resolve('secret/foo');
            expect(detectFn).to.not.have.been.called;
            expect(result.version).to.equal(1);
        });
    });

    // -------------------------------------------------------------------------
    // engines-only mode (autoDetect off, engines set) — how VaultClient wires it
    // -------------------------------------------------------------------------
    describe('engines-only mode (autoDetect off, engines set)', function () {
        it('applies the engines override for listed mounts but passes unlisted mounts through without detection', async function () {
            const detectFn = sinon.stub().rejects(new Error('should not be called'));
            // VaultClient sets disabled:true whenever autoDetect is off, but still
            // passes the engines map so listed mounts resolve without a detection call.
            const resolver = new MountResolver(detectFn, { secret: 2 }, logger, { disabled: true });

            const listed = await resolver.resolve('secret/foo');
            expect(listed.version).to.equal(2);
            expect(listed.mount).to.equal('secret');

            const unlisted = await resolver.resolve('other/bar');
            expect(unlisted.version).to.equal(1);
            expect(detectFn).to.not.have.been.called;
        });
    });
});
