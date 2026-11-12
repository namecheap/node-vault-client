import * as errors from '../src/errors';

const base: errors.VaultError = new errors.VaultError('boom');
const chained: errors.VaultError = new errors.VaultError('boom', { cause: new Error('root') });
const args: errors.InvalidArgumentsError = new errors.InvalidArgumentsError('bad');
const aws: errors.InvalidAWSCredentialsError = new errors.InvalidAWSCredentialsError('bad');
const expired: errors.AuthTokenExpiredError = new errors.AuthTokenExpiredError('gone');
const unsupported: errors.UnsupportedOperationError = new errors.UnsupportedOperationError('v2 only');
const http: errors.VaultHttpError = new errors.VaultHttpError(403, 'permission denied', { errors: [] });
const timedOut: errors.RequestTimeoutError = new errors.RequestTimeoutError(120000, { cause: new Error('timeout') });
const limit: number = timedOut.timeout;

const asError: Error = base;
const asVaultError: errors.VaultError = args;
const asInvalidArguments: errors.InvalidArgumentsError = aws;

const status: number = http.statusCode;
const body: unknown = http.error;
const rateLimited: errors.VaultHttpError = new errors.VaultHttpError(429, '', undefined, { retryAfter: '2' });
const noHeader: errors.VaultHttpError = new errors.VaultHttpError(503, '', undefined, { retryAfter: null });
const retryAfter: string | undefined = rateLimited.retryAfter;
const retryAfterMs: number | undefined = rateLimited.retryAfterMs;
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
    if (err instanceof errors.RequestTimeoutError) {
        return err.timeout;
    }
    return -1;
}

void [structurallyInterchangeable, chained, expired, unsupported, timedOut, limit, asError, asVaultError, asInvalidArguments, status, body, rateLimited, noHeader, retryAfter, retryAfterMs, name, message, narrows];

// @ts-expect-error statusCode is a number
const badStatus: string = http.statusCode;
void badStatus;

// @ts-expect-error VaultHttpError requires a status code and text
new errors.VaultHttpError();

// @ts-expect-error RequestTimeoutError requires the elapsed limit
new errors.RequestTimeoutError();

// @ts-expect-error there is no such export
new errors.NoSuchError('x');

// @ts-expect-error retryAfter is the raw header string, not a number of seconds
const badRetryAfter: number | undefined = rateLimited.retryAfter;
void badRetryAfter;

// @ts-expect-error retryAfterMs is a number of milliseconds, not the raw header
const badRetryAfterMs: string | undefined = rateLimited.retryAfterMs;
void badRetryAfterMs;

// @ts-expect-error the header goes in an options object, not as a positional string
new errors.VaultHttpError(429, '', undefined, '2');
