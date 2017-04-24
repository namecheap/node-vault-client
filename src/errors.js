'use strict';

class VaultError extends Error {
    constructor(message, error) {
        super(message);
        this.name = this.constructor.name;
        this.message = message;

        Error.captureStackTrace(this, this.constructor.name);
    }
}
class InvalidArgumentsError extends VaultError {}

module.exports = {
    VaultError,
    InvalidArgumentsError
};
