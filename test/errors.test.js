'use strict';

const chai = require('chai');
const expect = chai.expect;

const errors = require('../src/errors');

describe('errors', function () {
    it('exposes the expected error constructors', function () {
        expect(errors.VaultError).to.be.a('function');
        expect(errors.InvalidArgumentsError).to.be.a('function');
        expect(errors.InvalidAWSCredentialsError).to.be.a('function');
        expect(errors.AuthTokenExpiredError).to.be.a('function');
    });

    it('VaultError is an Error and sets name to the class name', function () {
        const e = new errors.VaultError('boom');
        expect(e).to.be.instanceof(Error);
        expect(e.name).to.equal('VaultError');
        expect(e.message).to.equal('boom');
    });

    it('InvalidArgumentsError extends VaultError', function () {
        const e = new errors.InvalidArgumentsError('bad args');
        expect(e).to.be.instanceof(errors.VaultError);
        expect(e).to.be.instanceof(Error);
        expect(e.name).to.equal('InvalidArgumentsError');
        expect(e.message).to.equal('bad args');
    });

    it('InvalidAWSCredentialsError extends InvalidArgumentsError and VaultError', function () {
        const e = new errors.InvalidAWSCredentialsError('no creds');
        expect(e).to.be.instanceof(errors.InvalidArgumentsError);
        expect(e).to.be.instanceof(errors.VaultError);
        expect(e.name).to.equal('InvalidAWSCredentialsError');
    });

    it('AuthTokenExpiredError extends VaultError', function () {
        const e = new errors.AuthTokenExpiredError('expired');
        expect(e).to.be.instanceof(errors.VaultError);
        expect(e.name).to.equal('AuthTokenExpiredError');
    });
});
