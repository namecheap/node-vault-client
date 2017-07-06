'use strict';

const deepFreeze = require('deep-freeze');
const chai = require('chai');
const expect = chai.expect;

const VaultClient = require('../src/VaultClient');
const VaultErr = require('../src/errors');

describe('Unit tests', function () {

    const bootOpts = deepFreeze({
        api: { url: 'https://example.com/' },
        logger: false,
        auth: {
            type: 'token',
            config: {
                token: 'XXXXXXXX-eb8e-5f25-fad2-79274fa13a64',
            }
        },
    });

    it('should correctly boot/get/clear VaultClient instance', () => {
        const i = VaultClient.boot('tst', bootOpts);

        expect(i).to.be.instanceOf(VaultClient);

        expect(VaultClient.get('tst')).to.equal(i);

        expect(() => VaultClient.boot('tst', bootOpts)).to.throw(VaultErr.InvalidArgumentsError, 'Instance with such name already booted');


        const i2 = VaultClient.boot('tst2', bootOpts);
        VaultClient.clear('tst');

        const inew = VaultClient.boot('tst', bootOpts);
        expect(inew).to.be.instanceOf(VaultClient);

        expect(VaultClient.get('tst2')).to.equal(i2);
    });



});
