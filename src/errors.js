const VaultError = require('./errors/vault.error');
const InvalidArgumentsError = require('./errors/invalid.arguments.error');
const InvalidAWSCredentialsError = require('./errors/invalid.aws.credentials.error');
const AuthTokenExpiredError = require('./errors/auth.token.expired.error');

module.exports = {
    VaultError,
    InvalidArgumentsError,
    InvalidAWSCredentialsError,
    AuthTokenExpiredError,
};
