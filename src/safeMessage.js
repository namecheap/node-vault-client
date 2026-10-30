'use strict';

const { StatusCodeError } = require('request-promise/errors');

/**
 * A message for `err` that is safe to log or to embed in another error's message
 * (GHSA-2vr8-g4vw-7xpm).
 *
 * request-promise's StatusCodeError message is `"<status> - <JSON body>"`, and a non-2xx Vault
 * body can still carry secret material: a transit batch decrypt with one bad item answers 400
 * with the other items' plaintexts in `data.batch_results`. So for those only the status and
 * Vault's own `errors` strings are kept. Any other error's message is returned unchanged, and a
 * rejection value that is not an error (`undefined`, a string) is stringified, so the catch
 * handler logging it cannot throw.
 *
 * @param {*} err
 * @returns {string}
 */
function safeMessage(err) {
    if (!(err instanceof StatusCodeError)) {
        return err && err.message !== undefined ? err.message : String(err);
    }

    const body = err.error;
    if (!body || typeof body !== 'object' || !Array.isArray(body.errors)) {
        return `${err.statusCode} - (response body omitted)`;
    }

    const vaultErrors = body.errors.filter((e) => typeof e === 'string');
    return `${err.statusCode} - ${JSON.stringify({ errors: vaultErrors })}`;
}

module.exports = safeMessage;
