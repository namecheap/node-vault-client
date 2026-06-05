import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import deepFreeze from 'deep-freeze';
import _ from 'lodash';
import { expect } from 'chai';
import VaultClient from '../../src/VaultClient.js';

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
        expect(list.getData()).is.deep.equal({keys: ['tst-val']});
    });

    it('Write for ssh backend should return response', async function () {
        const vaultClient = new VaultClient(this.bootOpts);
        await vaultClient.write('/sys/mounts/ssh', {type: 'ssh'});
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
        it('should renew token if needed', async function () {
            this.timeout(6000);

            const testData = {tst: 'testData', tstInt: 12345};

            let tmpToken = await rp({method: 'POST', uri: `${this.bootOpts.api.url}v1/auth/token/create-orphan`, body: {
                period: 2,
                explicit_max_ttl: 10,
            }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
            tmpToken = tmpToken.auth.client_token;

            const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {auth: {config: {token: tmpToken}}}));

            await vaultClient.write('/secret/tst-val', testData);

            await new Promise(resolve => {setTimeout(() => resolve(), 2500);});

            const res = await vaultClient.read('secret/tst-val');
            expect(res.getData()).is.deep.equal(testData);
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
            beforeEach(async function () {
                appRoleMount = `approle` + Math.floor(Math.random() * 1000);
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

                const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {
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

                const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {
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
        });
    });

});
