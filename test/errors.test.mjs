import { readFileSync } from 'node:fs';
import { expect } from 'chai';
import errors from '../src/errors.js';

const readRepoFile = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('errors', function () {
    it('exposes the expected error classes', function () {
        expect(errors).to.have.all.keys([
            'VaultError',
            'InvalidArgumentsError',
            'InvalidAWSCredentialsError',
            'AuthTokenExpiredError',
            'UnsupportedOperationError',
            'VaultHttpError',
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

        it('chains a wrapped error via the standard { cause } option', function () {
            const cause = new Error('root cause');
            const err = new errors.VaultError('boom', { cause });
            expect(err.message).to.equal('boom');
            expect(err.cause).to.equal(cause);
        });

        it('has no cause when constructed with only a message', function () {
            const err = new errors.VaultError('boom');
            expect(err.cause).to.equal(undefined);
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

        it('UnsupportedOperationError extends VaultError', function () {
            const err = new errors.UnsupportedOperationError('not supported');
            expect(err).to.be.instanceOf(errors.VaultError);
            expect(err).to.be.instanceOf(Error);
            expect(err.name).to.equal('UnsupportedOperationError');
            expect(err.message).to.equal('not supported');
        });

        it('VaultHttpError extends VaultError', function () {
            const err = new errors.VaultHttpError(503, 'sealed');
            expect(err).to.be.instanceOf(errors.VaultError);
            expect(err).to.be.instanceOf(Error);
            expect(err.name).to.equal('VaultHttpError');
        });
    });

    describe('VaultHttpError', function () {
        it('keeps the legacy "<status> - <text>" message shape', function () {
            const err = new errors.VaultHttpError(403, '{"errors":["permission denied"]}');
            expect(err.message).to.equal('403 - {"errors":["permission denied"]}');
        });

        it('exposes the status code as `statusCode` and the parsed body as `error`', function () {
            const body = { errors: ['permission denied'] };
            const err = new errors.VaultHttpError(403, '{"errors":["permission denied"]}', body);
            expect(err.statusCode).to.equal(403);
            expect(err.error).to.equal(body);
        });

        it('leaves `error` undefined when the response body is empty', function () {
            const err = new errors.VaultHttpError(500, '');
            expect(err.message).to.equal('500 - ');
            expect(err.error).to.equal(undefined);
        });
    });
});

describe('documented import path', function () {
    it('publishes src/errors.js, which the README gives as the import path', function () {
        const pkg = JSON.parse(readRepoFile('package.json'));
        const published = pkg.files.some((entry) => ['src', 'src/', 'src/errors.js'].includes(entry));

        expect(
            published,
            `package.json "files" (${pkg.files.join(', ')}) must publish src/errors.js`
        ).to.equal(true);
    });

    it('documents every exported class in the README', function () {
        const readme = readRepoFile('README.md');
        const section = readme.slice(readme.indexOf('### Error classes')).split(/^## /m)[0];

        expect(section).to.contain('### Error classes');
        for (const name of Object.keys(errors)) {
            expect(section, `${name} is exported but missing from the README table`).to.contain(name);
        }
    });
});
