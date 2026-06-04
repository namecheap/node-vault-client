'use strict';

// Silence node-config's "no configuration directory" warning during the run.
process.env.SUPPRESS_NO_CONFIG_WARNING = 'true';

const path = require('path');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;

const VaultNodeConfig = require('../src/VaultNodeConfig');
const errors = require('../src/errors');

const CONFIG_BASE = path.join(__dirname, 'data', 'config-base');
const CONFIG_NOT_OBJECT = path.join(__dirname, 'data', 'config-not-object');

function fakeVault(dataByPath) {
    return {
        read: (p) => Promise.resolve({ getData: () => dataByPath[p] }),
    };
}

describe('VaultNodeConfig', function () {
    let originalConfigDir;

    before(function () {
        originalConfigDir = process.env.NODE_CONFIG_DIR;
    });

    after(function () {
        if (originalConfigDir === undefined) {
            delete process.env.NODE_CONFIG_DIR;
        } else {
            process.env.NODE_CONFIG_DIR = originalConfigDir;
        }
    });

    describe('constructor', function () {
        it('constructs when the "config" package is installed', function () {
            const vnc = new VaultNodeConfig({});
            expect(vnc).to.be.instanceOf(VaultNodeConfig);
        });
    });

    describe('#__getSubstitutionMap()', function () {
        it('reads custom-vault-variables.js from an absolute NODE_CONFIG_DIR', function () {
            process.env.NODE_CONFIG_DIR = CONFIG_BASE;
            const vnc = new VaultNodeConfig({});
            expect(vnc.__getSubstitutionMap()).to.deep.equal({
                deep: { aStr: 'secret/a#tstStr', aInt: 'secret/a#tstInt' },
                b: 'secret/b#tst',
            });
        });

        it('resolves a relative NODE_CONFIG_DIR against the working directory', function () {
            process.env.NODE_CONFIG_DIR = './test/data/config-base';
            const vnc = new VaultNodeConfig({});
            expect(vnc.__getSubstitutionMap()).to.have.property('b', 'secret/b#tst');
        });

        it('returns a fresh clone on each call', function () {
            process.env.NODE_CONFIG_DIR = CONFIG_BASE;
            const vnc = new VaultNodeConfig({});
            const a = vnc.__getSubstitutionMap();
            const b = vnc.__getSubstitutionMap();
            expect(a).to.not.equal(b);
            expect(a).to.deep.equal(b);
        });

        it('throws a VaultError when the config file cannot be read', function () {
            process.env.NODE_CONFIG_DIR = path.join(__dirname, 'data', 'does-not-exist');
            const vnc = new VaultNodeConfig({});
            expect(() => vnc.__getSubstitutionMap()).to.throw(errors.VaultError, 'cannot be read');
        });

        it('throws a VaultError when the config file is not a plain object', function () {
            process.env.NODE_CONFIG_DIR = CONFIG_NOT_OBJECT;
            const vnc = new VaultNodeConfig({});
            expect(() => vnc.__getSubstitutionMap()).to.throw(errors.VaultError, 'should return plain object');
        });
    });

    describe('#__traverse()', function () {
        let vnc;
        beforeEach(function () {
            process.env.NODE_CONFIG_DIR = CONFIG_BASE;
            vnc = new VaultNodeConfig({});
        });

        it('invokes the callback for each string leaf, descending into nested objects', function () {
            const calls = [];
            vnc.__traverse({ a: 'x', nested: { b: 'y' } }, (key, val) => calls.push([key, val]));
            expect(calls).to.deep.equal([['a', 'x'], ['b', 'y']]);
        });

        it('skips inherited (non-own) properties', function () {
            const obj = Object.create({ inherited: 'nope' });
            obj.own = 'yes';
            const calls = [];
            vnc.__traverse(obj, (key, val) => calls.push([key, val]));
            expect(calls).to.deep.equal([['own', 'yes']]);
        });

        it('throws for an illegal (non-string, non-object) leaf type', function () {
            expect(() => vnc.__traverse({ a: 123 }, () => {}))
                .to.throw(errors.InvalidArgumentsError, 'Illegal key type');
        });
    });

    describe('#populate()', function () {
        function instance(substitutionMap, dataByPath) {
            process.env.NODE_CONFIG_DIR = CONFIG_BASE;
            const vnc = new VaultNodeConfig(fakeVault(dataByPath || {}));
            sinon.stub(vnc, '__getSubstitutionMap').returns(substitutionMap);
            return vnc;
        }

        it('throws (synchronously) on a substitution value without a "#"', function () {
            const vnc = instance({ key: 'no-hash-here' });
            expect(() => vnc.populate())
                .to.throw(errors.InvalidArgumentsError, 'Invalid format of substitution value');
        });

        it('rejects when a substitution cannot be found in the secret data', function () {
            const vnc = instance({ key: 'secret/a#missing' }, { 'secret/a': { present: 'v' } });
            return vnc.populate().then(
                () => { throw new Error('expected rejection'); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.VaultError);
                    expect(err.message).to.match(/Can't find substitution/);
                }
            );
        });

        it('resolves substitution values from Vault into the config object', function () {
            const vnc = instance(
                { b: 'secret/b#tst', deep: { aStr: 'secret/a#tstStr' } },
                { 'secret/a': { tstStr: 'hello' }, 'secret/b': { tst: 'world' } }
            );
            return vnc.populate().then((config) => {
                expect(config.b).to.equal('world');
                expect(config.deep.aStr).to.equal('hello');
            });
        });
    });
});
