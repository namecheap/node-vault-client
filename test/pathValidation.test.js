'use strict';

/**
 * KV path validation (GHSA-rr65-m54w-rfr9, GHSA-wf8v-q2h3-hgjm): read, list and write reject a
 * path that the URL handling or Vault would resolve to a different key, before the token fetch,
 * mount resolution or any request.
 */

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const VaultClient = require('../src/VaultClient');
const errors = require('../src/errors');

const MODES = {
    passthrough: {},
    engines: { engines: { secret: 2, 'team/kv': 2 } },
    autoDetect: { kv: { autoDetect: true } },
};

const CALLS = [
    ['read', (c, p) => c.read(p)],
    ['list', (c, p) => c.list(p)],
    ['write', (c, p) => c.write(p, { owner: 'attacker' })],
];

// The advisories' payloads, plus double encoding, raw CR/LF and an unpaired surrogate.
const UNSAFE = [
    'secret/apps/me/../victim/key',
    'secret/../../other/data/x',
    'secret/apps/me/%2e%2e/victim/key',
    'secret/apps/me/.%2E/victim/key',
    'secret/apps/me/..\\victim/key',
    'secret/apps/me/.\t./victim/key',
    'secret/apps/me/.. ',
    'secret/apps/me/..\u0001',
    'secret/apps/victim#/key',
    'secret/apps/me/x?version=1',
    'secret/apps/me/..%2fvictim%2fkey',
    'secret/apps/me/..%2f',
    'secret/apps/me/../../../../sys/policies/acl/p',
    'secret/apps/me/..\\..\\..\\..\\sys/mounts/m',
    'secret/../sys/mounts/m',
    'secret/apps/me/x\n',
    'secret/apps/me/.\r./x',
    'secret/tenants/../../../../../../secret/data/tenants/attacker/profile#',
    'secret/tenants//%252e%252e%252fvictim',
    'secret/tenants/me/%252e%252e%252fvictim',
    'secret//foo',
    'secret/tenants//key',
    'secre%74/config',
    'secret/apps/\ud800x',
    'secret/apps/x\udc00',
    '',
];

function client(mode) {
    const c = new VaultClient({
        api: Object.assign({ url: 'http://127.0.0.1:8200/' }, MODES[mode]),
        auth: { type: 'token', config: { token: 'tok' } },
        logger: false,
    });
    sinon.stub(c.__auth, 'getAuthToken').resolves({ getId: () => 'tok' });
    sinon.stub(c.__api, 'makeRequest').callsFake((method, apiPath) => Promise.resolve(apiPath.startsWith('sys/internal/ui/mounts/')
        ? { data: { path: apiPath.startsWith('sys/internal/ui/mounts/team/') ? 'team/kv/' : 'secret/', type: 'kv', options: { version: '2' } } }
        : { data: { data: { a: 1 }, metadata: { version: 1 } } }));
    return c;
}

async function rejection(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    return null;
}

describe('KV path validation', function () {
    Object.keys(MODES).forEach((mode) => {
        describe(`${mode} mode`, function () {
            UNSAFE.forEach((unsafe) => {
                CALLS.forEach(([name, call]) => {
                    it(`${name}(${JSON.stringify(unsafe)}) is rejected before any request`, async function () {
                        const c = client(mode);
                        const err = await rejection(call(c, unsafe));

                        expect(err).to.be.instanceOf(errors.InvalidArgumentsError);
                        expect(c.__auth.getAuthToken).to.not.have.been.called;
                        expect(c.__api.makeRequest).to.not.have.been.called;
                        if (unsafe.length > 3) {
                            expect(err.message, 'the message must not echo the path').to.not.include(unsafe);
                        }
                    });
                });
            });

            [undefined, null, 42, {}].forEach((value) => {
                it(`read(${String(value)}) is rejected`, async function () {
                    const c = client(mode);
                    expect(await rejection(c.read(value))).to.be.instanceOf(errors.InvalidArgumentsError);
                    expect(c.__api.makeRequest).to.not.have.been.called;
                });
            });
        });
    });

    describe('safe paths keep working', function () {
        [
            ['secret/MyApp/DB_PASSWORD', 'secret/data/MyApp/DB_PASSWORD'],
            ['secret/users/alice@example.com', 'secret/data/users/alice@example.com'],
            ['secret/k%3Fv%23w', 'secret/data/k%3Fv%23w'],
            ['secret/a.b/c', 'secret/data/a.b/c'],
            ['secret/.hidden', 'secret/data/.hidden'],
            ['secret/a..b', 'secret/data/a..b'],
            ['secret/my key', 'secret/data/my key'],
            ['/secret/lead', 'secret/data/lead'],
        ].forEach(([safe, apiPath]) => {
            it(`read(${JSON.stringify(safe)}) -> ${apiPath} (engines)`, async function () {
                const c = client('engines');
                await c.read(safe);
                expect(c.__api.makeRequest).to.have.been.calledWith('GET', apiPath);
            });
        });

        it('passthrough sends the path as written, minus leading slashes', async function () {
            const c = client('passthrough');
            await c.write('/sys/mounts/ssh', { type: 'ssh' });
            await c.list('secret/apps/');
            expect(c.__api.makeRequest.firstCall.args.slice(0, 2)).to.deep.equal(['POST', 'sys/mounts/ssh']);
            expect(c.__api.makeRequest.secondCall.args.slice(0, 2)).to.deep.equal(['LIST', 'secret/apps/']);
        });

        it('autoDetect rewrites a leading-slash KV v2 path inside the named mount', async function () {
            const c = client('autoDetect');
            await c.write('/secret/lead', { a: 1 });
            expect(c.__api.makeRequest.lastCall.args.slice(0, 2)).to.deep.equal(['POST', 'secret/data/lead']);
        });
    });

    describe('percent-encoded segment of a multi-segment mount', function () {
        ['engines', 'autoDetect'].forEach((mode) => {
            it(`read('team/k%76/config') is rejected without a KV request (${mode})`, async function () {
                const c = client(mode);
                const err = await rejection(c.read('team/k%76/config'));

                expect(err).to.be.instanceOf(errors.InvalidArgumentsError);
                const kvCalls = c.__api.makeRequest.getCalls().filter((call) => !call.args[1].startsWith('sys/internal/ui/mounts/'));
                expect(kvCalls).to.have.lengthOf(0);
            });
        });
    });
});
