import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import deepFreeze from 'deep-freeze';
import _ from 'lodash';
import { expect } from 'chai';
import VaultClient from '../../src/VaultClient.js';
import errors from '../../src/errors.js';
import { describeKvPathValidation } from './kv-path-validation.mjs';
import { createSpyLogger } from '../helpers/logger.mjs';

const _require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Minimal request-promise replacement built on the global fetch (Node >=18):
// returns the parsed JSON body, throws on non-2xx.
async function rp(opts) {
    const response = await fetch(opts.uri, {
        method: opts.method || 'GET',
        headers: Object.assign({ Accept: 'application/json' }, opts.headers, opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: 'follow',
    });
    const text = await response.text();
    let data;
    if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!response.ok) {
        const error = new Error(`${response.status} - ${text}`);
        error.statusCode = response.status;
        throw error;
    }
    return data;
}

describe('E2E', function () {

    beforeEach(async function () {
        this.bootOpts = deepFreeze({
            api: { url: 'http://127.0.0.1:8200/' },
            logger: false,
            auth: {
                type: 'token',
                config: {
                    token: '8274d2a1-c80c-ff56-c6ed-1b99f7bcea78', // see docker-compose.yml
                }
            },
        });
    });

    afterEach(async function () {
        delete _require.cache[_require.resolve('config')];
    });

    it('Simple read/write', async function () {
        const testData = {tst: 'testData', tstInt: 12345};

        const vaultClient = new VaultClient(this.bootOpts);

        await vaultClient.write('/secret/tst-val', testData);

        const res = await vaultClient.read('secret/tst-val');
        expect(res.getData()).is.deep.equal(testData);

        const list = await vaultClient.list('secret');
        // `include`, not deep-equal: other tests in this suite write their own keys under
        // secret/, and a rerun against a still-running compose stack sees the previous
        // run's too (#137).
        expect(list.getData().keys).to.include('tst-val');
    });

    it('close() with auth.revokeOnClose revokes the token on the Vault server (#202)', async function () {
        // A child of the dev root token, so revoking it cannot touch the token the rest of
        // the suite shares.
        const created = await rp({
            uri: 'http://127.0.0.1:8200/v1/auth/token/create',
            method: 'POST',
            headers: { 'X-Vault-Token': this.bootOpts.auth.config.token },
            body: {},
        });
        const childToken = created.auth.client_token;

        const vaultClient = new VaultClient({
            api: { url: 'http://127.0.0.1:8200/' },
            logger: false,
            auth: { type: 'token', config: { token: childToken }, revokeOnClose: true },
        });

        await vaultClient.write('/secret/tst-revoke-on-close', {x: 1});

        const revocation = vaultClient.close();
        expect(revocation, 'the revocation is returned so a caller may await it').to.be.instanceOf(Promise);
        await revocation;

        // The token is gone server-side: lookup-self with it must now answer 403.
        let statusCode = null;
        try {
            await rp({
                uri: 'http://127.0.0.1:8200/v1/auth/token/lookup-self',
                headers: { 'X-Vault-Token': childToken },
            });
        } catch (err) {
            statusCode = err.statusCode;
        }
        expect(statusCode, 'the revoked token no longer authenticates').to.equal(403);
    });

    it('Write for ssh backend should return response', async function () {
        const vaultClient = new VaultClient(this.bootOpts);
        // Already mounted by a previous run against the same stack: Vault answers
        // 400 "path is already in use", which is success for our purposes (#137).
        try {
            await vaultClient.write('/sys/mounts/ssh', {type: 'ssh'});
        } catch (err) {
            if (!(err instanceof errors.VaultHttpError) || !/already in use/.test(err.message)) {
                throw err;
            }
        }
        await vaultClient.write('/ssh/roles/otp_key_role', {key_type: 'otp', default_user: 'ubuntu', cidr_list: '127.0.0.0/24'});
        const response = await vaultClient.write('/ssh/creds/otp_key_role', {ip: '127.0.0.1'});

        expect(response.data.ip).to.equal('127.0.0.1');
        expect(response.data.key_type).to.equal('otp');
        expect(response.data.key).a('string');
        expect(response.data.username).to.equal('ubuntu');
    });

    it('should fill node-config', async function () {
        const testData = Object.freeze({tstStr: 'testData', tstInt: 12345});

        const vaultClient = new VaultClient(this.bootOpts);
        await vaultClient.write('/secret/a', testData);
        await vaultClient.write('/secret/b', {tst: 'ZZZ'});

        process.env.NODE_CONFIG_DIR = `${__dirname}/../data/config-base`;
        const config = _require('config');

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});

        await vaultClient.fillNodeConfig();

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: testData.tstStr, aInt: testData.tstInt}, b: 'ZZZ'});
    });

    it('should handle empty custom-vault-variables', async function () {
        const vaultClient = new VaultClient(this.bootOpts);

        process.env.NODE_CONFIG_DIR = `${__dirname}/../data/config-empty`;
        const config = _require('config');

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});

        await vaultClient.fillNodeConfig();

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});
    });

    describe('Auth Token renewal', function () {
        /** Count renew-self calls made through the global fetch until the returned restore() runs. */
        function countRenewals() {
            const originalFetch = globalThis.fetch;
            const renewals = [];
            globalThis.fetch = (input, options) => {
                const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
                if (new URL(url).pathname.endsWith('/auth/token/renew-self')) {
                    renewals.push(url);
                }
                return originalFetch.call(globalThis, input, options);
            };
            return { renewals, restore: () => { globalThis.fetch = originalFetch; } };
        }

        /** A logger that records warnings, so a stop the reads alone would not catch still fails. */
        function warnRecorder() {
            const warnings = [];
            const noop = () => {};
            return { warnings, logger: { error: noop, info: noop, debug: noop, trace: noop, warn: (...args) => warnings.push(args.join(' ')) } };
        }

        async function createToken(bootOpts, body) {
            const res = await rp({method: 'POST', uri: `${bootOpts.api.url}v1/auth/token/create-orphan`, body,
                headers: {'X-Vault-Token': bootOpts.auth.config.token}});
            return res.auth.client_token;
        }

        // An uncapped periodic token renewed less than a second apart: lookup-self's whole-second
        // ttl flips between 2 and 3 and each renewal moves the deadline by under a second. The
        // pre-3.0.2 wall-clock rule read that as "maximum TTL reached" and stopped renewing.
        it('keeps an uncapped period-3 token alive with sub-second renewals', async function () {
            this.timeout(30000);
            const token = await createToken(this.bootOpts, {period: '3s'});
            const { warnings, logger } = warnRecorder();
            const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {logger, auth: {config: {token}, renewalFraction: 0.2}}));
            const { renewals, restore } = countRenewals();

            try {
                await vaultClient.write('/secret/tst-renew', {v: 1});
                await new Promise(resolve => setTimeout(resolve, 7000));
                const res = await vaultClient.read('secret/tst-renew');
                expect(res.getData()).to.deep.equal({v: 1});
                expect(renewals.length, 'renewed throughout, more than two periods past the original deadline')
                    .to.be.at.least(8);
                expect(warnings.filter((w) => w.includes('renewal stopped')), 'renewal must never stop').to.deep.equal([]);
            } finally {
                restore();
                vaultClient.close();
            }
        });

        // renewalIncrement equal to the remaining lifetime leaves the deadline where it was on
        // the first renewal, with no max TTL anywhere. Only renewing keeps this token past 4 s.
        it('keeps renewing an uncapped token whose renewals do not move its deadline', async function () {
            this.timeout(30000);
            const token = await createToken(this.bootOpts, {ttl: '4s'});
            const { warnings, logger } = warnRecorder();
            const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {logger, auth: {config: {token}, renewalIncrement: 2}}));
            const { renewals, restore } = countRenewals();

            try {
                await vaultClient.write('/secret/tst-renew', {v: 2});
                await new Promise(resolve => setTimeout(resolve, 6000));
                const res = await vaultClient.read('secret/tst-renew');
                expect(res.getData()).to.deep.equal({v: 2});
                expect(renewals.length).to.be.at.least(3);
                expect(warnings.filter((w) => w.includes('renewal stopped')), 'renewal must never stop').to.deep.equal([]);
            } finally {
                restore();
                vaultClient.close();
            }
        });

        // A token_period above token_max_ttl makes Vault warn `period of "4s" exceeded the
        // effective max_ttl of "2s"; period value is capped accordingly` on every renewal, yet the
        // token stays renewable indefinitely at the 2 s period. That warning is not the stop signal.
        it('keeps renewing a periodic AppRole token whose period Vault capped to token_max_ttl', async function () {
            this.timeout(30000);
            const vault = this.bootOpts.api.url;
            const headers = {'X-Vault-Token': this.bootOpts.auth.config.token};
            const mount = `approle-period-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            await rp({method: 'PUT', uri: `${vault}v1/sys/policy/tst-renew-period`, headers,
                body: {policy: 'path "secret/*" { capabilities = ["create", "read", "update"] }'}});
            await rp({method: 'POST', uri: `${vault}v1/sys/auth/${mount}`, headers, body: {type: 'approle'}});
            const { warnings, logger } = warnRecorder();
            const { renewals, restore } = countRenewals();
            let vaultClient;

            try {
                await rp({method: 'POST', uri: `${vault}v1/auth/${mount}/role/p`, headers,
                    body: {token_period: '4s', token_max_ttl: '2s', token_policies: 'tst-renew-period'}});
                const roleId = (await rp({uri: `${vault}v1/auth/${mount}/role/p/role-id`, headers})).data.role_id;
                const secretId = (await rp({method: 'POST', uri: `${vault}v1/auth/${mount}/role/p/secret-id`, headers})).data.secret_id;
                vaultClient = new VaultClient(_.merge({}, this.bootOpts, {
                    logger,
                    auth: {type: 'appRole', mount, config: {role_id: roleId, secret_id: secretId}},
                }));

                await vaultClient.write('/secret/tst-renew', {v: 3});
                await new Promise(resolve => setTimeout(resolve, 6000));
                const res = await vaultClient.read('secret/tst-renew');
                expect(res.getData()).to.deep.equal({v: 3});
                expect(renewals.length, 'renewed about every second at the capped 2 s period').to.be.at.least(4);
                expect(warnings.filter((w) => w.includes('renewal stopped')), 'renewal must never stop').to.deep.equal([]);
            } finally {
                restore();
                if (vaultClient) {
                    vaultClient.close();
                }
                await rp({method: 'DELETE', uri: `${vault}v1/sys/auth/${mount}`, headers});
            }
        });

        it('renews once, then stops when a real Vault token reaches max TTL', async function () {
            this.timeout(30000);

            const testData = {tst: 'testData', tstInt: 12345};

            let tmpToken = await rp({method: 'POST', uri: `${this.bootOpts.api.url}v1/auth/token/create-orphan`, body: {
                period: 10,
                explicit_max_ttl: 10,
            }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
            tmpToken = tmpToken.auth.client_token;

            const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {auth: {config: {token: tmpToken}}}));
            const originalFetch = globalThis.fetch;
            const renewals = [];
            globalThis.fetch = (input, options) => {
                const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
                if (new URL(url).pathname.endsWith('/auth/token/renew-self')) {
                    renewals.push(url);
                }
                return originalFetch.call(globalThis, input, options);
            };

            try {
                await vaultClient.write('/secret/tst-val', testData);

                // The first renewal is due at roughly half of the ten-second max TTL. Waiting
                // beyond that point exercises Vault's real, sub-second expiry movement at cap.
                await new Promise(resolve => setTimeout(resolve, 6500));
                const res = await vaultClient.read('secret/tst-val');
                expect(res.getData()).is.deep.equal(testData);
                expect(renewals, 'the capped token should have renewed once').to.have.lengthOf(1);

                await new Promise(resolve => setTimeout(resolve, 5500));
                let expiryError;
                try {
                    await vaultClient.read('secret/tst-val');
                } catch (err) {
                    expiryError = err;
                }
                expect(expiryError).to.be.instanceOf(errors.AuthTokenExpiredError);
                expect(renewals, 'the client must stop renewing at max TTL').to.have.lengthOf(1);
            } finally {
                globalThis.fetch = originalFetch;
                vaultClient.close();
            }
        });
    });

    describe('Auth backends', function () {
        beforeEach(async function () {
            await rp({method: 'PUT', uri: `${this.bootOpts.api.url}v1/sys/policy/tst`, body: {
                rules: 'path "*" {policy = "sudo"}',
            }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
        });

        describe('AppRole', function () {
            let appRoleMount;
            // An AppRole login yields a renewable token, whose renewal timer would keep the
            // process alive after the suite (#220).
            let vaultClient;
            afterEach(async function () {
                if (vaultClient) {
                    vaultClient.close();
                    vaultClient = undefined;
                }
                // Unmounted after each test, and named per run: a random number from 0 to 999
                // collided with a mount another test (or an earlier run on the same Vault) left.
                if (appRoleMount) {
                    const headers = {'X-Vault-Token': this.bootOpts.auth.config.token};
                    // The #235 tests write here; Vault answers 204 when the key is not there.
                    await rp({method: 'DELETE', uri: `${this.bootOpts.api.url}v1/secret/${appRoleMount}/allowed/k`, headers});
                    await rp({method: 'DELETE', uri: `${this.bootOpts.api.url}v1/sys/auth/${appRoleMount}`, headers});
                    appRoleMount = undefined;
                }
            });

            beforeEach(async function () {
                appRoleMount = `approle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                await rp({method: 'POST', uri: `${this.bootOpts.api.url}v1/sys/auth/${appRoleMount}`, body: {
                    type: 'approle',
                }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
            });

            it.skip('without secret ID', async function () {
                const testData = {tst: 'testData', tstInt: 12345};

                await rp({method: 'POST', uri: `${this.bootOpts.api.url}v1/auth/${appRoleMount}/role/tst`, body: {
                    bind_secret_id: 'false',
                    bound_cidr_list: '127.0.0.1/32',
                    policies: 'tst'
                }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
                let roleId = await rp({
                    uri: `${this.bootOpts.api.url}v1/auth/${appRoleMount}/role/tst/role-id`, json: true,
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token}
                });
                roleId = roleId.data.role_id;

                vaultClient = new VaultClient(_.merge({}, this.bootOpts, {
                    auth: {
                        type: 'appRole',
                        mount: appRoleMount,
                        config: {role_id: roleId}
                    }
                }));

                await vaultClient.write('/secret/tst-val', testData);

                const res = await vaultClient.read('secret/tst-val');
                expect(res.getData()).is.deep.equal(testData);
            });

            it('with secret ID', async function () {
                const testData = {tst: 'testData', tstInt: 12345};

                await rp({method: 'POST', uri: `${this.bootOpts.api.url}v1/auth/${appRoleMount}/role/tst`, body: {
                    policies: 'tst'
                }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
                let roleId = await rp({
                    uri: `${this.bootOpts.api.url}v1/auth/${appRoleMount}/role/tst/role-id`, json: true,
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token}
                });
                roleId = roleId.data.role_id;
                let secretId = await rp({
                    method: 'POST',
                    uri: `${this.bootOpts.api.url}v1/auth/${appRoleMount}/role/tst/secret-id`, json: true,
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token}
                });
                secretId = secretId.data.secret_id;

                vaultClient = new VaultClient(_.merge({}, this.bootOpts, {
                    auth: {
                        type: 'appRole',
                        mount: appRoleMount,
                        config: {role_id: roleId, secret_id: secretId}
                    }
                }));

                await vaultClient.write('/secret/tst-val', testData);

                const res = await vaultClient.read('secret/tst-val');
                expect(res.getData()).is.deep.equal(testData);
            });

            describe('a 403 on a secret request (#235)', function () {
                let logger;
                const root = { 'X-Vault-Token': '8274d2a1-c80c-ff56-c6ed-1b99f7bcea78' };
                const logins = () => logger.info.getCalls()
                    .filter((call) => call.args[0] === 'getting auth token (mount=%s)').length;

                beforeEach(async function () {
                    const url = this.bootOpts.api.url;
                    await rp({method: 'PUT', uri: `${url}v1/sys/policy/tst-narrow`, body: {
                        policy: `path "secret/${appRoleMount}/allowed/*" { capabilities = ["create", "update", "read"] }`,
                    }, json: true, headers: root});
                    await rp({method: 'POST', uri: `${url}v1/auth/${appRoleMount}/role/narrow`, body: {
                        token_policies: 'tst-narrow',
                    }, json: true, headers: root});
                    const roleId = (await rp({uri: `${url}v1/auth/${appRoleMount}/role/narrow/role-id`, headers: root})).data.role_id;
                    const secretId = (await rp({method: 'POST', uri: `${url}v1/auth/${appRoleMount}/role/narrow/secret-id`, headers: root})).data.secret_id;

                    logger = createSpyLogger();
                    vaultClient = new VaultClient(_.merge({}, this.bootOpts, {
                        auth: {type: 'appRole', mount: appRoleMount, config: {role_id: roleId, secret_id: secretId}},
                    }, {logger}));
                    await vaultClient.write(`secret/${appRoleMount}/allowed/k`, {v: 1});
                });

                it('logs in again once after Vault revokes the token server-side', async function () {
                    await rp({method: 'PUT', uri: `${this.bootOpts.api.url}v1/sys/leases/revoke-prefix/auth/${appRoleMount}/login`, headers: root});

                    const lease = await vaultClient.read(`secret/${appRoleMount}/allowed/k`);

                    expect(lease.getData()).to.deep.equal({v: 1});
                    expect(logins()).to.equal(2);
                });

                it('surfaces a policy denial without logging in again', async function () {
                    const error = await vaultClient.read(`secret/${appRoleMount}/denied`).then(() => null, (err) => err);

                    expect(error).to.be.instanceOf(errors.VaultHttpError);
                    expect(error.statusCode).to.equal(403);
                    expect(logins()).to.equal(1);
                });
            });
        });
    });

    describeKvPathValidation({
        url: 'http://127.0.0.1:8200/',
        rootToken: '8274d2a1-c80c-ff56-c6ed-1b99f7bcea78', // see docker-compose.yml
        kvVersion: 1,
    });

});
