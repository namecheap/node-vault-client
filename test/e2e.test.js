'use strict';

const chai = require('chai');
const expect = chai.expect;
const assert = chai.assert;

const loadVault = require('./vaultLoader');

describe('E2E', function () {

    it('ZZZZ', () => {
        return loadVault().then(res => {
            console.log(res.token);
            return res.kill();
        });
    });

});
