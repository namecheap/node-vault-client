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

// The longest delay setTimeout() honours; a longer one fires after 1 ms (same limit as api.timeout).
const MAX_DELAY_MS = 2147483647;

/**
 * Parses a `Retry-After` header value (RFC 9110 §10.2.3): delay-seconds or an HTTP-date.
 *
 * @param {string} value - the raw header value, trimmed and not empty
 * @param {number} now - current time in milliseconds
 * @returns {number|undefined} milliseconds to wait, at most MAX_DELAY_MS; `undefined` for a
 *   value in neither format (e.g. `-5`, or `30, 120` from two headers)
 */
function parseRetryAfter(value, now) {
    if (/^\d+$/.test(value)) {
        return Math.min(Number(value) * 1000, MAX_DELAY_MS);
    }
    // An HTTP-date always names the day or the month; Date.parse() alone also accepts e.g. "-5".
    const date = /[a-z]/i.test(value) ? Date.parse(value) : NaN;
    if (Number.isNaN(date)) {
        return undefined;
    }
    return Math.min(Math.max(0, date - now), MAX_DELAY_MS);
}

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
     * @param {Object} [headers] - response headers the error exposes:
     * @param {string|null} [headers.retryAfter] - the raw `Retry-After` header, `null` or
     *   `undefined` when it was not sent. Vault's rate-limit quotas answer 429 with it, in
     *   seconds; proxies in front of Vault send it with 429 and 503. Exposed as
     *   `error.retryAfter` (raw) and `error.retryAfterMs` (parsed); both are absent when the
     *   header was not sent or is empty, and `retryAfterMs` also when it cannot be parsed.
     */
    constructor(statusCode, text, body, { retryAfter } = {}) {
        super(`${statusCode} - ${text}`);
        this.statusCode = statusCode;
        this.error = body;

        const value = typeof retryAfter === 'string' ? retryAfter.trim() : '';
        if (value !== '') {
            this.retryAfter = value;
            const ms = parseRetryAfter(value, Date.now());
            if (ms !== undefined) {
                this.retryAfterMs = ms;
            }
        }
    }
}

/**
 * A request to Vault did not complete within `api.timeout` milliseconds: response headers,
 * body and any redirects included. The `fetch()` rejection (a `TimeoutError` DOMException)
 * is on `cause`.
 */
class RequestTimeoutError extends VaultError {
    /**
     * @param {number} timeout - the `api.timeout` that elapsed, in milliseconds. Exposed as
     *   `error.timeout`.
     * @param {{cause?: *}} [options]
     */
    constructor(timeout, options) {
        super(`Vault request timed out after ${timeout} ms (api.timeout)`, options);
        this.timeout = timeout;
    }
}

module.exports = {
    VaultError,
    InvalidArgumentsError,
    InvalidAWSCredentialsError,
    AuthTokenExpiredError,
    UnsupportedOperationError,
    VaultHttpError,
    RequestTimeoutError,
};
