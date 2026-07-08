'use strict';

class VaultError extends Error {
    /**
     * @param {string} message
     * @param {{cause?: *}} [options] - standard `Error` options. Pass `{ cause }` to chain the
     *   underlying error (e.g. a wrapped HTTP/transport failure); it is exposed as `error.cause`.
     */
    constructor(message, options) {
        super(message, options);
        this.name = this.constructor.name;
        this.message = message;

        Error.captureStackTrace(this, this.constructor);
    }
}
class InvalidArgumentsError extends VaultError {}
class InvalidAWSCredentialsError extends InvalidArgumentsError {}
class AuthTokenExpiredError extends VaultError {}
class UnsupportedOperationError extends VaultError {}

/**
 * A non-2xx HTTP response from the Vault server.
 *
 * Preserves the legacy plain-`Error` shape previously thrown by
 * {@link VaultApiClient#makeRequest} — the message stays `"<status> - <raw body text>"` and the
 * `statusCode`/`error` properties keep their meaning — while letting callers
 * `instanceof`-check HTTP failures against the `VaultError` hierarchy.
 */
class VaultHttpError extends VaultError {
    /**
     * @param {number} statusCode - HTTP status code of the response.
     * @param {string} text - raw response body text, used in the message.
     * @param {*} [body] - parsed JSON body when the response was valid JSON, the raw text
     *   otherwise, or `undefined` for an empty body. Exposed as `error.error`.
     */
    constructor(statusCode, text, body) {
        super(`${statusCode} - ${text}`);
        this.statusCode = statusCode;
        this.error = body;
    }
}

module.exports = {
    VaultError,
    InvalidArgumentsError,
    InvalidAWSCredentialsError,
    AuthTokenExpiredError,
    UnsupportedOperationError,
    VaultHttpError,
};
