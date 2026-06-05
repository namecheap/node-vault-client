'use strict';

class VaultError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
        this.message = message;

        Error.captureStackTrace(this, this.constructor);
    }
}
class InvalidArgumentsError extends VaultError {}
class InvalidAWSCredentialsError extends InvalidArgumentsError {}
class AuthTokenExpiredError extends VaultError {}

module.exports = {
    VaultError,
    InvalidArgumentsError,
    InvalidAWSCredentialsError,
    AuthTokenExpiredError,
};
