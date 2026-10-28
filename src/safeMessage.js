'use strict';

const { VaultHttpError } = require('./errors');

/**
 * A message for `err` that is safe to log or to embed in another error's message.
 *
 * A {@link VaultHttpError}'s own message is `"<status> - <raw body text>"` (kept for
 * compatibility), and a non-2xx Vault body can still carry secret material: a transit batch
 * decrypt with one bad item answers 400 with the other items' plaintexts in
 * `data.batch_results`. So for those only the status and Vault's own `errors` strings are
 * kept. Any other error's message is returned unchanged, and a rejection value that is not an
 * error (`undefined`, a string) is stringified, so the catch handler logging it cannot throw.
 *
 * @param {*} err
 * @returns {string}
 */
function safeMessage(err) {
    if (!(err instanceof VaultHttpError)) {
        return err && err.message !== undefined ? err.message : String(err);
    }

    const body = err.error;
    if (!body || !Array.isArray(body.errors)) {
        return `${err.statusCode} - (response body omitted)`;
    }

    const vaultErrors = body.errors.filter((e) => typeof e === 'string');
    return `${err.statusCode} - ${JSON.stringify({ errors: vaultErrors })}`;
}

module.exports = safeMessage;
