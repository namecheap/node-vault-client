const VaultError = require('./vault.error');

class AuthTokenExpiredError extends VaultError {}

module.exports = AuthTokenExpiredError;
