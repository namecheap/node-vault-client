import net from 'node:net';
import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultBaseAuth from '../src/auth/VaultBaseAuth.js';
import AuthToken from '../src/auth/AuthToken.js';
import safeMessage from '../src/safeMessage.js';
import errors from '../src/errors.js';
import { LOG_METHODS, createNoopLogger, createSpyLogger, loggedText } from './helpers/logger.mjs';

use(sinonChai);

/**
 * GHSA-2vr8-g4vw-7xpm: a non-2xx Vault response body can carry secret material, and the
 * library used to write it to the error log through VaultHttpError#message. A transit batch
 * decrypt with one bad item answers 400 with the other items' plaintexts in
 * data.batch_results; a KV v2 read of a soft-deleted secret answers 404 with its metadata.
 * Neither body has an `errors` key.
 */
const MARKER = 'TOP-SECRET-PLAINTEXT-MARKER';
const SECRET_BODY = JSON.stringify({
    request_id: 'r1',
    data: { batch_results: [{ plaintext: MARKER }, { plaintext: '', error: 'invalid ciphertext: no prefix' }] },
    auth: { client_token: `hvs.${MARKER}` },
    wrap_info: null,
    warnings: null,
});

const OPERATIONS = {
    read: (c) => c.read('secret/app'),
    list: (c) => c.list('secret/app'),
    write: (c) => c.write('secret/app', { k: 'v' }),
    delete: (c) => c.delete('secret/app'),
    update: (c) => c.update('secret/app', { k: 'v' }),
    request: (c) => c.request('POST', 'transit/decrypt/app', { batch_input: [] }),
    deleteVersions: (c) => c.deleteVersions('secret/app', [1]),
    undeleteVersions: (c) => c.undeleteVersions('secret/app', [1]),
    destroyVersions: (c) => c.destroyVersions('secret/app', [1]),
    readMetadata: (c) => c.readMetadata('secret/app'),
    deleteMetadata: (c) => c.deleteMetadata('secret/app'),
};

// Public methods that are not Vault operations with their own failure log.
const NOT_OPERATIONS = ['constructor', 'close', 'fillNodeConfig', 'getHeaders'];

const TOKEN_LOOKUP = JSON.stringify({ data: { id: 'tok', accessor: 'acc', creation_time: 0, ttl: 0, renewable: false } });
const KV2_MOUNT = JSON.stringify({ data: { path: 'secret/', type: 'kv', options: { version: '2' } } });

/**
 * A raw TCP HTTP/1.1 fixture: node:http cannot parse the LIST method that list() sends.
 * `route(method, target)` returns `{ status, body }`.
 */
function startFixture(route) {
    const server = net.createServer((socket) => {
        let buf = '';
        socket.on('data', (chunk) => {
            buf += chunk.toString('latin1');
            const headEnd = buf.indexOf('\r\n\r\n');
            if (headEnd === -1) return;
            const head = buf.slice(0, headEnd);
            const len = Number((/^content-length:\s*(\d+)/im.exec(head) || [])[1] || 0);
            if (buf.length < headEnd + 4 + len) return;
            const [method, target] = head.split(' ');
            buf = '';
            const { status, body } = route(method, target);
            socket.end(`HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n` +
                `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

describe('error logging never writes a non-2xx response body (GHSA-2vr8-g4vw-7xpm)', function () {
    let server;
    let url;
    let failure;
    let detection;
    let clients;

    before(async function () {
        server = await startFixture((method, target) => {
            if (target === '/v1/auth/token/lookup-self') return { status: 200, body: TOKEN_LOOKUP };
            if (target.startsWith('/v1/sys/internal/ui/mounts/')) return detection;
            return failure;
        });
        url = `http://127.0.0.1:${server.address().port}`;
    });

    after(function (done) {
        server.close(done);
    });

    beforeEach(function () {
        failure = { status: 400, body: SECRET_BODY };
        detection = { status: 200, body: KV2_MOUNT };
        clients = [];
    });

    afterEach(function () {
        sinon.restore();
        clients.forEach((c) => c.close());
    });

    function makeClient(logger) {
        const opts = { api: { url, kv: { autoDetect: true } }, auth: { type: 'token', config: { token: 'tok' } } };
        if (logger !== undefined) {
            opts.logger = logger;
        }
        const client = new VaultClient(opts);
        clients.push(client);
        return client;
    }

    function rejectionOf(promise) {
        return promise.then(() => { throw new Error('expected rejection'); }, (err) => err);
    }

    it('covers every public operation', function () {
        const methods = Object.getOwnPropertyNames(VaultClient.prototype)
            .filter((name) => !name.startsWith('__') && !NOT_OPERATIONS.includes(name));
        expect(Object.keys(OPERATIONS)).to.have.members(methods);
    });

    Object.keys(OPERATIONS).forEach((op) => {
        describe(`${op}()`, function () {
            it('keeps the body out of every level of a custom logger', async function () {
                const log = createSpyLogger();
                const err = await rejectionOf(OPERATIONS[op](makeClient(log)));

                expect(err).to.be.instanceOf(errors.VaultHttpError);
                expect(loggedText(log), 'response body must not be logged').to.not.contain(MARKER);
                expect(log.error).to.have.been.calledOnce;
                expect(log.error.firstCall.args[1]).to.equal('400 - (response body omitted)');
            });

            it('keeps the body out of the default console logger', async function () {
                const consoleSpies = LOG_METHODS.concat('log').map((m) => sinon.stub(console, m));
                const err = await rejectionOf(OPERATIONS[op](makeClient()));
                const printed = _.flatMap(consoleSpies, (s) => _.flatMap(s.getCalls(), (c) => c.args)).join(' ');
                sinon.restore();

                expect(err).to.be.instanceOf(errors.VaultHttpError);
                expect(printed, 'response body must not be printed').to.not.contain(MARKER);
                expect(printed).to.contain('400 - (response body omitted)');
            });

            it('leaves the thrown VaultHttpError contract unchanged', async function () {
                const err = await rejectionOf(OPERATIONS[op](makeClient(false)));

                expect(err).to.be.instanceOf(errors.VaultHttpError);
                expect(err.message).to.equal(`400 - ${SECRET_BODY}`);
                expect(err.statusCode).to.equal(400);
                expect(err.error).to.deep.equal(JSON.parse(SECRET_BODY));
            });
        });
    });

    it('falls back to the default logger, still without the body, for an incomplete custom logger', async function () {
        const consoleError = sinon.stub(console, 'error');
        const partial = _.omit(createSpyLogger(), 'trace');
        await rejectionOf(makeClient(partial).request('POST', 'transit/decrypt/app', {}));
        const printed = _.flatMap(consoleError.getCalls(), (c) => c.args).join(' ');
        sinon.restore();

        expect(partial.error).to.not.have.been.called;
        expect(printed).to.contain('raw request failed');
        expect(printed).to.not.contain(MARKER);
    });

    it('logs Vault\'s own errors strings but nothing else from the body', async function () {
        failure = { status: 403, body: JSON.stringify({ errors: ['permission denied'], data: { leak: MARKER } }) };
        const log = createSpyLogger();
        await rejectionOf(makeClient(log).write('secret/app', { k: 'v' }));

        expect(log.error).to.have.been.calledWith('write secret failed: %s', '403 - {"errors":["permission denied"]}');
        expect(loggedText(log)).to.not.contain(MARKER);
    });

    it('logs only the status for a non-JSON body, such as a proxy error page', async function () {
        failure = { status: 502, body: `<html><body>Bad Gateway X-Vault-Token: ${MARKER}</body></html>` };
        const log = createSpyLogger();
        const err = await rejectionOf(makeClient(log).read('secret/app'));

        expect(err.error).to.contain(MARKER);
        expect(log.error).to.have.been.calledWith('read secret failed: %s', '502 - (response body omitted)');
        expect(loggedText(log)).to.not.contain(MARKER);
    });

    it('keeps a failed mount detection body out of both the log and the wrapping VaultError message', async function () {
        detection = { status: 400, body: SECRET_BODY };
        const log = createSpyLogger();
        const err = await rejectionOf(makeClient(log).read('secret/app'));

        expect(err).to.be.instanceOf(errors.VaultError);
        expect(err).to.not.be.instanceOf(errors.VaultHttpError);
        expect(err.message).to.contain('Failed to detect KV engine version');
        expect(err.message).to.not.contain(MARKER);
        // The original HTTP failure stays reachable for callers that need it.
        expect(err.cause).to.be.instanceOf(errors.VaultHttpError);
        expect(err.cause.error).to.deep.equal(JSON.parse(SECRET_BODY));
        expect(loggedText(log)).to.not.contain(MARKER);
    });

    it('keeps the mount detection guidance and Vault errors in the wrapping message', async function () {
        detection = { status: 403, body: '{"errors":["permission denied"]}\n' };
        const err = await rejectionOf(makeClient(false).read('secret/app'));

        expect(err.message).to.equal(
            'Failed to detect KV engine version for mount "secret" (path: secret/app): ' +
            '403 - {"errors":["permission denied"]}. Set api.engines or disable autoDetect to bypass detection.'
        );
    });

    it('still logs the message of a non-HTTP failure', async function () {
        const log = createSpyLogger();
        const client = makeClient(log);
        client.__api = new VaultApiClient({ url: 'http://127.0.0.1:1' }, createNoopLogger());
        const err = await rejectionOf(client.request('GET', 'sys/health'));

        expect(err).to.not.be.instanceOf(errors.VaultHttpError);
        expect(log.error).to.have.been.calledWith('raw request failed: %s', err.message);
    });

    describe('token renewal', function () {
        let clock;

        class RenewingAuth extends VaultBaseAuth {
            _authenticate() {
                return Promise.resolve(new AuthToken('rid', 'racc', 0, 100, 0, 0, true));
            }
        }

        beforeEach(function () {
            clock = sinon.useFakeTimers();
        });

        afterEach(function () {
            clock.restore();
        });

        async function failRenewalWith(reason) {
            const api = sinon.createStubInstance(VaultApiClient);
            // callsFake, not rejects(): sinon replaces a falsy rejects() value with a generic Error.
            api.makeRequest.callsFake(() => Promise.reject(reason));
            const log = createSpyLogger();
            const auth = new RenewingAuth(api, log, 'token');
            await auth.getAuthToken();
            clock.tick(50000);
            for (let i = 0; i < 8; i++) {
                await Promise.resolve();
            }
            auth.cancelTokenRefresh();
            return log;
        }

        it('keeps a failed renewal body out of the log', async function () {
            const log = await failRenewalWith(new errors.VaultHttpError(400, SECRET_BODY, JSON.parse(SECRET_BODY)));

            expect(log.error).to.have.been.calledWith('token renew failed: %s', '400 - (response body omitted)');
            expect(log.error).to.have.been.calledWith(
                'Cannot refresh auth token with "racc" accessor. Error: 400 - (response body omitted)');
            expect(loggedText(log)).to.not.contain(MARKER);
        });

        it('still logs a non-HTTP renewal failure with its stack', async function () {
            const boom = new Error('socket hang up');
            const log = await failRenewalWith(boom);

            expect(log.error).to.have.been.calledWith('token renew failed: %s', 'socket hang up');
            expect(log.error).to.have.been.calledWith('Cannot refresh auth token with "racc" accessor.', boom);
            // The message is logged once, inside the error, not again on a line of its own.
            expect(log.error.getCalls().filter((call) => String(call.args[0]).includes('socket hang up'))).to.have.length(0);
        });

        it('logs a renewal rejected with undefined instead of throwing in the catch handler', async function () {
            const log = await failRenewalWith(undefined);

            expect(log.error).to.have.been.calledWith('token renew failed: %s', 'undefined');
            expect(log.error).to.have.been.calledWith('Cannot refresh auth token with "racc" accessor.', undefined);
        });
    });
});

describe('safeMessage()', function () {
    it('returns the message of an error that is not a VaultHttpError unchanged', function () {
        expect(safeMessage(new errors.VaultError('boom'))).to.equal('boom');
        expect(safeMessage(new TypeError('fetch failed'))).to.equal('fetch failed');
    });

    it('stringifies a rejection value that is not an error', function () {
        expect(safeMessage(undefined)).to.equal('undefined');
        expect(safeMessage(null)).to.equal('null');
        expect(safeMessage('timeout')).to.equal('timeout');
        expect(safeMessage({ code: 'ECONNRESET' })).to.equal('[object Object]');
    });

    it('keeps only the status and Vault errors strings of a VaultHttpError', function () {
        const body = { errors: ['permission denied', { nested: MARKER }], data: { value: MARKER } };
        expect(safeMessage(new errors.VaultHttpError(403, JSON.stringify(body), body)))
            .to.equal('403 - {"errors":["permission denied"]}');
    });

    it('keeps an empty errors array', function () {
        expect(safeMessage(new errors.VaultHttpError(404, '{"errors":[]}', { errors: [] })))
            .to.equal('404 - {"errors":[]}');
    });

    it('escapes control characters in Vault errors strings', function () {
        const body = { errors: ['line one\nline two'] };
        expect(safeMessage(new errors.VaultHttpError(400, JSON.stringify(body), body)))
            .to.equal('400 - {"errors":["line one\\nline two"]}');
    });

    it('omits a body without an errors array', function () {
        [
            [`plain ${MARKER}`, `plain ${MARKER}`],
            ['', undefined],
            ['null', null],
            [`{"errors":"${MARKER}"}`, { errors: MARKER }],
            [`["${MARKER}"]`, [MARKER]],
        ].forEach(([text, body]) => {
            expect(safeMessage(new errors.VaultHttpError(500, text, body)))
                .to.equal('500 - (response body omitted)');
        });
    });
});
