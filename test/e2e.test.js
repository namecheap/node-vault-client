'use strict';

const deepFreeze = require('deep-freeze');
const axios = require('axios');
const _ = require('lodash');
const chai = require('chai');
const expect = chai.expect;
const loadVault = require('./vaultLoader');
const VaultClient = require('../src/VaultClient');

describe('E2E', function () {

    beforeEach(async function () {
        this.vaultServer = await loadVault();

        this.bootOpts = deepFreeze({
            api: { url: 'http://127.0.0.1:8200/' },
            logger: false,
            auth: {
                type: 'token',
                config: {
                    token: this.vaultServer.rootToken,
                }
            },
        });
    });

    afterEach(async function () {
        await this.vaultServer.kill();
        delete require.cache[require.resolve('config')];
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

        process.env.NODE_CONFIG_DIR = `${__dirname}/data/config-base`;
        const config = require('config');

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});

        await vaultClient.fillNodeConfig();

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: testData.tstStr, aInt: testData.tstInt}, b: 'ZZZ'});
    });

    it('should handle empty custom-vault-variables', async function () {
        const testData = Object.freeze({tstStr: 'testData', tstInt: 12345});

        const vaultClient = new VaultClient(this.bootOpts);

        process.env.NODE_CONFIG_DIR = `${__dirname}/data/config-empty`;
        const config = require('config');

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});

        await vaultClient.fillNodeConfig();

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});
    });

    describe('Auth Token renewal', function () {
        it('should renew token if needed', async function () {
            this.timeout(6000);

            const testData = {tst: 'testData', tstInt: 12345};

            let { data: tmpToken } = await axios.request({method: 'POST', url: `${this.bootOpts.api.url}v1/auth/token/create-orphan`, data: {
                period: 2,
                explicit_max_ttl: 10,
            }, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
            tmpToken = tmpToken.auth.client_token;

            const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {auth: {config: {token: tmpToken}}}));

            await vaultClient.write('/secret/tst-val', testData);

            await new Promise(resolve => {setTimeout(() => resolve(), 2500)});

            const res = await vaultClient.read('secret/tst-val');
            expect(res.getData()).is.deep.equal(testData);
        });
    });

    describe('Auth backends', function () {
        beforeEach(async function () {
            await axios.request({method: 'PUT', url: `${this.bootOpts.api.url}v1/sys/policy/tst`, data: {
                rules: 'path "*" {policy = "sudo"}',
            }, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
        });

        describe('AppRole', function () {
            beforeEach(async function () {
                await axios.request({method: 'POST', url: `${this.bootOpts.api.url}v1/sys/auth/approle`, data: {
                    type: 'approle',
                }, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
            });

            it('without secret ID', async function () {
                const testData = {tst: 'testData', tstInt: 12345};


                await axios.request({method: 'POST', url: `${this.bootOpts.api.url}v1/auth/approle/role/tst`, data: {
                    bind_secret_id: 'false',
                    bound_cidr_list: '127.0.0.1/32',
                    policies: 'tst'
                }, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
                let { data: roleId } = await axios.request({
                    url: `${this.bootOpts.api.url}v1/auth/approle/role/tst/role-id`,
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token}
                });
                roleId = roleId.data.role_id;

                const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {auth: {type: 'appRole', config: {role_id: roleId}}}));


                await vaultClient.write('/secret/tst-val', testData);

                const res = await vaultClient.read('secret/tst-val');
                expect(res.getData()).is.deep.equal(testData);
            });

            it('with secret ID', async function () {
                const testData = {tst: 'testData', tstInt: 12345};

                await axios.request({method: 'POST', url: `${this.bootOpts.api.url}v1/auth/approle/role/tst`, data: {
                    policies: 'tst'
                }, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
                let { data: roleId } =  await axios.request({
                    url: `${this.bootOpts.api.url}v1/auth/approle/role/tst/role-id`,
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token}
                });
                roleId = roleId.data.role_id;
                let { data: secretId } = await axios.request({
                    method: 'POST',
                    url: `${this.bootOpts.api.url}v1/auth/approle/role/tst/secret-id`,
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token}
                });
                secretId = secretId.data.secret_id;

                const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {auth: {type: 'appRole', config: {role_id: roleId, secret_id: secretId}}}));


                await vaultClient.write('/secret/tst-val', testData);

                const res = await vaultClient.read('secret/tst-val');
                expect(res.getData()).is.deep.equal(testData);
            });
        });
    });

});
