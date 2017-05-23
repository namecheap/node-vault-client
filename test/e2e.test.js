'use strict';

require('co-mocha');

const deepFreeze = require('deep-freeze');
const rp = require('request-promise');
const _ = require('lodash');
const chai = require('chai');
const expect = chai.expect;

const loadVault = require('./vaultLoader');

const VaultClient = require('../src/VaultClient');

describe('E2E', function () {

    beforeEach(function* () {
        this.vaultServer = yield loadVault();

        this.bootOpts = deepFreeze({
            api: { url: 'http://127.0.0.1:8200/' },
            auth: {
                type: 'token',
                config: {
                    token: this.vaultServer.rootToken,
                }
            },
        });
    });
    
    afterEach(function* () {
        yield this.vaultServer.kill();
        delete require.cache[require.resolve('config')];
    });

    it('Simple read/write', function* () {
        const testData = {tst: 'testData', tstInt: 12345};

        const vaultClient = new VaultClient(this.bootOpts);

        yield vaultClient.write('/secret/tst-val', testData);

        const res = yield vaultClient.read('secret/tst-val');
        expect(res.getData()).is.deep.equal(testData);
    });

    it('should fill node-config', function* () {
        const testData = Object.freeze({tstStr: 'testData', tstInt: 12345});

        const vaultClient = new VaultClient(this.bootOpts);
        yield vaultClient.write('/secret/a', testData);
        yield vaultClient.write('/secret/b', {tst: 'ZZZ'});

        process.env.NODE_CONFIG_DIR = `${__dirname}/data/config-base`;
        const config = require('config');

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});

        yield vaultClient.fillNodeConfig();

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: testData.tstStr, aInt: testData.tstInt}, b: 'ZZZ'});
    });

    it('should handle empty custom-vault-variables', function* () {
        const testData = Object.freeze({tstStr: 'testData', tstInt: 12345});

        const vaultClient = new VaultClient(this.bootOpts);

        process.env.NODE_CONFIG_DIR = `${__dirname}/data/config-empty`;
        const config = require('config');

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});

        yield vaultClient.fillNodeConfig();

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});
    });

    describe('Auth Token renewal', function () {
        it('should renew token if needed', function* () {
            this.timeout(6000);

            const testData = {tst: 'testData', tstInt: 12345};

            const {auth: {client_token: tmpToken}} = yield rp({method: 'POST', uri: `${this.bootOpts.api.url}v1/auth/token/create-orphan`, body: {
                period: 2,
                explicit_max_ttl: 10,
            }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});

            const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {auth: {config: {token: tmpToken}}}));

            yield vaultClient.write('/secret/tst-val', testData);

            yield new Promise(resolve => {setTimeout(() => resolve(), 2500)});

            const res = yield vaultClient.read('secret/tst-val');
            expect(res.getData()).is.deep.equal(testData);
        });
    });

});
