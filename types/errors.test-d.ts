import * as errors from '../src/errors';

const base: errors.VaultError = new errors.VaultError('boom');
const chained: errors.VaultError = new errors.VaultError('boom', { cause: new Error('root') });
const args: errors.InvalidArgumentsError = new errors.InvalidArgumentsError('bad');
const aws: errors.InvalidAWSCredentialsError = new errors.InvalidAWSCredentialsError('bad');
const expired: errors.AuthTokenExpiredError = new errors.AuthTokenExpiredError('gone');
const unsupported: errors.UnsupportedOperationError = new errors.UnsupportedOperationError('v2 only');
const http: errors.VaultHttpError = new errors.VaultHttpError(403, 'permission denied', { errors: [] });

const asError: Error = base;
const asVaultError: errors.VaultError = args;
const asInvalidArguments: errors.InvalidArgumentsError = aws;

const status: number = http.statusCode;
const body: unknown = http.error;
const name: string = base.name;
const message: string = base.message;

const structurallyInterchangeable: errors.InvalidArgumentsError = base;

function narrows(err: unknown): number {
    if (err instanceof errors.VaultHttpError) {
        return err.statusCode;
    }
    if (err instanceof errors.UnsupportedOperationError) {
        return 0;
    }
    return -1;
}

void [structurallyInterchangeable, chained, expired, unsupported, asError, asVaultError, asInvalidArguments, status, body, name, message, narrows];

// @ts-expect-error statusCode is a number
const badStatus: string = http.statusCode;
void badStatus;

// @ts-expect-error VaultHttpError requires a status code and text
new errors.VaultHttpError();

// @ts-expect-error there is no such export
new errors.NoSuchError('x');
