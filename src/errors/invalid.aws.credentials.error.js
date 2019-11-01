const VaultError = require('./vault.error');

class InvalidAWSCredentialsError extends VaultError {}

module.exports = InvalidAWSCredentialsError;
