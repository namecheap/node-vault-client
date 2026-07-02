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

module.exports = {
    VaultError,
    InvalidArgumentsError,
    InvalidAWSCredentialsError,
    AuthTokenExpiredError,
    UnsupportedOperationError,
};
