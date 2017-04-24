'use strict';

require('co-mocha');

const deepFreeze = require('deep-freeze');
const chai = require('chai');
const expect = chai.expect;

const loadVault = require('./vaultLoader');

const VaultClient = require('../src/VaultClient');
const VaultErr = require('../src/errors');

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
    });

    it('Simple read/write', function* () {
        const testData = {tst: 'testData', tstInt: 12345};

        const vaultClient = new VaultClient(this.bootOpts);

        yield vaultClient.write('/secret/tst-val', testData);

        const res = yield vaultClient.read('secret/tst-val');
        expect(res.getData()).is.deep.equal(testData);
    });

});
