import { expect } from 'chai';
import errors from '../src/errors.js';

describe('errors', function () {
    it('exposes the expected error classes', function () {
        expect(errors).to.have.all.keys([
            'VaultError',
            'InvalidArgumentsError',
            'InvalidAWSCredentialsError',
            'AuthTokenExpiredError',
        ]);
    });

    describe('VaultError', function () {
        it('is an Error carrying the message, name and a stack trace', function () {
            const err = new errors.VaultError('boom');
            expect(err).to.be.instanceOf(Error);
            expect(err.name).to.equal('VaultError');
            expect(err.message).to.equal('boom');
            expect(err.stack).to.be.a('string');
        });

        it('accepts an optional wrapped error argument', function () {
            const cause = new Error('cause');
            const err = new errors.VaultError('boom', cause);
            expect(err.message).to.equal('boom');
        });
    });

    describe('error hierarchy', function () {
        it('InvalidArgumentsError extends VaultError', function () {
            const err = new errors.InvalidArgumentsError('bad arg');
            expect(err).to.be.instanceOf(errors.VaultError);
            expect(err).to.be.instanceOf(Error);
            expect(err.name).to.equal('InvalidArgumentsError');
        });

        it('InvalidAWSCredentialsError extends InvalidArgumentsError', function () {
            const err = new errors.InvalidAWSCredentialsError('bad creds');
            expect(err).to.be.instanceOf(errors.InvalidArgumentsError);
            expect(err).to.be.instanceOf(errors.VaultError);
            expect(err.name).to.equal('InvalidAWSCredentialsError');
        });

        it('AuthTokenExpiredError extends VaultError', function () {
            const err = new errors.AuthTokenExpiredError('expired');
            expect(err).to.be.instanceOf(errors.VaultError);
            expect(err).to.not.be.instanceOf(errors.InvalidArgumentsError);
            expect(err.name).to.equal('AuthTokenExpiredError');
        });
    });
});
