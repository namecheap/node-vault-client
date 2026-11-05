/**
 * api.timeout (issue #223): every request to Vault, logins and renewals included, is bounded by
 * a per-request deadline that rejects with RequestTimeoutError.
 */
import http from 'node:http';
import { defaultMaxListeners, getEventListeners, getMaxListeners, setMaxListeners } from 'node:events';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultClient from '../src/VaultClient.js';
import errors from '../src/errors.js';
import { createNoopLogger, createSpyLogger } from './helpers/logger.mjs';

use(sinonChai);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function settle(promise) {
    return promise.then((value) => ({ value }), (error) => ({ error }));
}

/** A fetch() double that never answers and rejects with the signal's reason when it aborts. */
function hangingFetch() {
    return sinon.stub(globalThis, 'fetch').callsFake((url, options) => new Promise((resolve, reject) => {
        if (options.signal) {
            options.signal.addEventListener('abort', () => reject(options.signal.reason));
        }
    }));
}

describe('api.timeout (request deadline)', function () {
    let server;
    let baseUrl;

    before(function (done) {
        server = http.createServer((req, res) => {
            const path = req.url;
            if (path === '/v1/auth/token/lookup-self') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    data: {
                        id: 'tok', accessor: 'acc', ttl: 10, renewable: true,
                        expire_time: new Date(Date.now() + 10000).toISOString(),
                    },
                }));
            } else if (path.startsWith('/v1/secret/ok')) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ data: { k: 'v' } }));
            } else if (path.startsWith('/v1/secret/denied')) {
                res.statusCode = 403;
                res.end(JSON.stringify({ errors: ['permission denied'] }));
            } else if (path.startsWith('/v1/secret/redirect')) {
                res.statusCode = 302;
                res.setHeader('Location', '/v1/secret/hang');
                res.end();
            } else if (path.startsWith('/v1/sys/internal/ui/mounts/')) {
                // Mount detection never answers either.
            } else if (path.startsWith('/v1/secret/drip')) {
                // Headers and part of the body, then nothing.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.write('{"data":');
            }
            // Anything else (secret/hang, renew-self) is accepted and never answered.
        });
        server.listen(0, '127.0.0.1', () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            done();
        });
    });

    afterEach(function () {
        sinon.restore();
        server.closeAllConnections();
    });

    after(function (done) {
        server.closeAllConnections();
        server.close(done);
    });

    describe('VaultApiClient', function () {
        it('rejects with RequestTimeoutError when Vault accepts the request and never answers', async function () {
            const api = new VaultApiClient({ url: baseUrl, timeout: 100 }, createNoopLogger());
            const started = Date.now();

            const { error } = await settle(api.makeRequest('GET', '/secret/hang'));

            expect(Date.now() - started).to.be.within(90, 2000);
            expect(error).to.be.instanceOf(errors.RequestTimeoutError);
            expect(error).to.be.instanceOf(errors.VaultError);
            expect(error.timeout).to.equal(100);
            expect(error.cause.name).to.equal('TimeoutError');
            // The message is logged by every operation: it must not carry the path or URL.
            expect(error.message).to.equal('Vault request timed out after 100 ms (api.timeout)');
        });

        it('bounds the response body too, not just the headers', async function () {
            const api = new VaultApiClient({ url: baseUrl, timeout: 100 }, createNoopLogger());

            const { error } = await settle(api.makeRequest('GET', '/secret/drip'));

            expect(error).to.be.instanceOf(errors.RequestTimeoutError);
        });

        it('bounds a request that is redirected to an endpoint that never answers', async function () {
            const api = new VaultApiClient({ url: baseUrl, timeout: 300 }, createNoopLogger());

            const { error } = await settle(api.makeRequest('GET', '/secret/redirect'));

            expect(error).to.be.instanceOf(errors.RequestTimeoutError);
        });

        [['not set', {}], ['null', { timeout: null }]].forEach(([label, extra]) => it(`defaults to 120000 ms when ${label}`, async function () {
            const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            hangingFetch();
            const api = new VaultApiClient(Object.assign({ url: baseUrl }, extra), createNoopLogger());

            const result = settle(api.makeRequest('GET', '/secret/hang'));
            await clock.tickAsync(119999);
            let settled = false;
            result.then(() => { settled = true; });
            await Promise.resolve();
            expect(settled).to.equal(false);

            await clock.tickAsync(1);
            const { error } = await result;
            expect(error).to.be.instanceOf(errors.RequestTimeoutError);
            expect(error.timeout).to.equal(120000);
        }));

        it('throws synchronously as before, with no timer or listener left, when the call fails before fetch() returns', async function () {
            const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const controller = new AbortController();
            const throwingLogger = Object.assign(createNoopLogger(), { debug() { throw new Error('logger broke'); } });
            const broken = new VaultApiClient(
                { url: baseUrl, timeout: 5000, requestOptions: { signal: controller.signal } }, throwingLogger);
            expect(() => broken.makeRequest('GET', '/secret/ok')).to.throw('logger broke');

            sinon.stub(globalThis, 'fetch').throws(new TypeError('fetch replaced'));
            const api = new VaultApiClient(
                { url: baseUrl, timeout: 5000, requestOptions: { signal: controller.signal } }, createNoopLogger());
            expect(() => api.makeRequest('GET', '/secret/ok')).to.throw('fetch replaced');

            expect(clock.countTimers()).to.equal(0);
            expect(getEventListeners(controller.signal, 'abort')).to.have.lengthOf(0);
        });

        it('clears its timer once the request settles, so no timer outlives a fast request', async function () {
            const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const fetchStub = sinon.stub(globalThis, 'fetch');
            fetchStub.onFirstCall().resolves(new Response(JSON.stringify({ ok: true }), { status: 200 }));
            fetchStub.onSecondCall().resolves(new Response('{"errors":["denied"]}', { status: 403 }));
            fetchStub.onThirdCall().rejects(new TypeError('fetch failed'));
            const api = new VaultApiClient({ url: baseUrl, timeout: 5000 }, createNoopLogger());

            expect(await api.makeRequest('GET', '/secret/ok')).to.deep.equal({ ok: true });
            expect(clock.countTimers()).to.equal(0);
            expect((await settle(api.makeRequest('GET', '/secret/denied'))).error)
                .to.be.instanceOf(errors.VaultHttpError);
            expect(clock.countTimers()).to.equal(0);
            expect((await settle(api.makeRequest('GET', '/secret/ok'))).error.message).to.equal('fetch failed');
            expect(clock.countTimers()).to.equal(0);
        });

        it('starts a fresh deadline for every request', async function () {
            const api = new VaultApiClient({ url: baseUrl, timeout: 300 }, createNoopLogger());

            expect(await api.makeRequest('GET', '/secret/ok')).to.deep.equal({ data: { k: 'v' } });
            await delay(400);
            expect(await api.makeRequest('GET', '/secret/ok')).to.deep.equal({ data: { k: 'v' } });
        });

        it('leaves a non-2xx answer a VaultHttpError', async function () {
            const api = new VaultApiClient({ url: baseUrl, timeout: 1000 }, createNoopLogger());

            const { error } = await settle(api.makeRequest('GET', '/secret/denied'));

            expect(error).to.be.instanceOf(errors.VaultHttpError);
            expect(error.statusCode).to.equal(403);
        });

        it('timeout: 0 sends the fetch() options exactly as before, with no signal', async function () {
            const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
                new Response(JSON.stringify({ ok: true }), { status: 200 }));
            const api = new VaultApiClient({ url: baseUrl, timeout: 0 }, createNoopLogger());

            await api.makeRequest('POST', '/secret/ok', { a: 1 }, { 'X-Vault-Token': 't' });

            expect(fetchStub.firstCall.args[1]).to.deep.equal({
                redirect: 'follow',
                method: 'POST',
                headers: { Accept: 'application/json', 'X-Vault-Token': 't', 'Content-Type': 'application/json' },
                body: '{"a":1}',
            });
        });

        describe('with a requestOptions.signal', function () {
            it('still aborts with that signal\'s own reason, not RequestTimeoutError', async function () {
                const controller = new AbortController();
                const api = new VaultApiClient(
                    { url: baseUrl, timeout: 5000, requestOptions: { signal: controller.signal } }, createNoopLogger());

                const result = settle(api.makeRequest('GET', '/secret/hang'));
                await delay(20);
                controller.abort();
                const { error } = await result;

                expect(error).to.equal(controller.signal.reason);
                expect(error.name).to.equal('AbortError');
            });

            it('rejects at once when that signal has already aborted', async function () {
                const controller = new AbortController();
                const reason = new Error('shutting down');
                controller.abort(reason);
                const api = new VaultApiClient(
                    { url: baseUrl, timeout: 5000, requestOptions: { signal: controller.signal } }, createNoopLogger());

                const { error } = await settle(api.makeRequest('GET', '/secret/ok'));

                expect(error).to.equal(reason);
            });

            it('applies api.timeout alongside it', async function () {
                const controller = new AbortController();
                const api = new VaultApiClient(
                    { url: baseUrl, timeout: 100, requestOptions: { signal: controller.signal } }, createNoopLogger());

                const { error } = await settle(api.makeRequest('GET', '/secret/hang'));

                expect(error).to.be.instanceOf(errors.RequestTimeoutError);
            });

            it('removes its listener from that long-lived signal once each request settles', async function () {
                const controller = new AbortController();
                const api = new VaultApiClient(
                    { url: baseUrl, timeout: 500, requestOptions: { signal: controller.signal } }, createNoopLogger());

                await api.makeRequest('GET', '/secret/ok');
                await settle(api.makeRequest('GET', '/secret/hang'));
                await settle(api.makeRequest('GET', '/secret/denied'));

                expect(getEventListeners(controller.signal, 'abort')).to.have.lengthOf(0);
            });

            it('raises its listener limit to 1500 like fetch() did, so many requests in flight do not warn', async function () {
                const controller = new AbortController();
                // Node 20 starts an AbortSignal at the EventEmitter default (10), later versions
                // at 0 (no limit); like fetch(), only the default is raised.
                const initial = getMaxListeners(controller.signal);
                const warnings = [];
                const onWarning = (warning) => warnings.push(warning.name);
                process.on('warning', onWarning);
                try {
                    const api = new VaultApiClient(
                        { url: baseUrl, timeout: 5000, requestOptions: { signal: controller.signal } }, createNoopLogger());
                    const inFlight = Array.from({ length: 20 }, () => settle(api.makeRequest('GET', '/secret/hang')));
                    await delay(50);
                    expect(getEventListeners(controller.signal, 'abort')).to.have.lengthOf(20);
                    controller.abort();
                    await Promise.all(inFlight);
                    await delay(10);
                } finally {
                    process.off('warning', onWarning);
                }

                expect(getMaxListeners(controller.signal)).to.equal(initial === defaultMaxListeners ? 1500 : initial);
                expect(warnings).to.not.include('MaxListenersExceededWarning');
            });

            it('leaves a listener limit the caller set alone', async function () {
                const controller = new AbortController();
                setMaxListeners(50, controller.signal);
                const api = new VaultApiClient(
                    { url: baseUrl, timeout: 5000, requestOptions: { signal: controller.signal } }, createNoopLogger());

                await api.makeRequest('GET', '/secret/ok');

                expect(getMaxListeners(controller.signal)).to.equal(50);
            });

            it('follows a signal-like object (an abort-controller polyfill) and applies api.timeout with it', async function () {
                // What Node 20/22 fetch() accepts: a boolean `aborted` and an addEventListener.
                class PolyfillSignal {
                    constructor() { this.aborted = false; this.reason = undefined; this.listeners = new Set(); }
                    addEventListener(type, fn) { this.listeners.add(fn); }
                    removeEventListener(type, fn) { this.listeners.delete(fn); }
                    abort(reason) { this.aborted = true; this.reason = reason; this.listeners.forEach((fn) => fn()); }
                }
                const polyfill = new PolyfillSignal();
                const api = new VaultApiClient(
                    { url: baseUrl, timeout: 300, requestOptions: { signal: polyfill } }, createNoopLogger());

                const timedOut = await settle(api.makeRequest('GET', '/secret/hang'));
                expect(timedOut.error).to.be.instanceOf(errors.RequestTimeoutError);
                expect(polyfill.listeners.size).to.equal(0);

                const result = settle(api.makeRequest('GET', '/secret/hang'));
                await delay(20);
                const reason = new Error('polyfill abort');
                polyfill.abort(reason);
                expect((await result).error).to.equal(reason);
                expect(polyfill.listeners.size).to.equal(0);
            });

            it('passes a value that is not an AbortSignal through untouched, as before', async function () {
                const bogus = { notASignal: true };
                const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
                    new Response('{}', { status: 200 }));
                const api = new VaultApiClient(
                    { url: baseUrl, timeout: 100, requestOptions: { signal: bogus } }, createNoopLogger());

                await api.makeRequest('GET', '/secret/ok');

                expect(fetchStub.firstCall.args[1].signal).to.equal(bogus);
            });
        });

        describe('validation', function () {
            [0, 1, 30000, 2147483647, null].forEach((timeout) => {
                it(`accepts ${timeout}`, function () {
                    expect(() => new VaultApiClient({ url: baseUrl, timeout }, createNoopLogger())).to.not.throw();
                });
            });

            [-1, 1.5, NaN, Infinity, 2147483648, '30000', true].forEach((timeout) => {
                it(`rejects ${String(timeout)} (${typeof timeout}) with InvalidArgumentsError`, function () {
                    expect(() => new VaultApiClient({ url: baseUrl, timeout }, createNoopLogger()))
                        .to.throw(errors.InvalidArgumentsError, '"api.timeout" should be an integer number of milliseconds');
                });
            });

            it('warns about a limit under one second, which is likely a value written in seconds', function () {
                const logger = createSpyLogger();
                new VaultApiClient({ url: baseUrl, timeout: 30 }, logger);
                expect(logger.warn).to.have.been.calledOnceWith(
                    '"api.timeout" is %d ms; it is in milliseconds, not seconds', 30);

                const quiet = createSpyLogger();
                [0, 1000, 120000].forEach((timeout) => new VaultApiClient({ url: baseUrl, timeout }, quiet));
                expect(quiet.warn).to.not.have.been.called;
            });
        });
    });

    describe('VaultClient', function () {
        let client;

        afterEach(function () {
            if (client) {
                client.close();
                client = undefined;
            }
        });

        it('rejects an operation that Vault never answers (the #223 reproduction)', async function () {
            const logger = createSpyLogger();
            client = new VaultClient({
                api: { url: `${baseUrl}/`, timeout: 1000 },
                logger,
                auth: { type: 'token', renewal: false, config: { token: 'tok' } },
            });

            const { error } = await settle(client.read('secret/hang'));

            expect(error).to.be.instanceOf(errors.RequestTimeoutError);
            expect(logger.error).to.have.been.calledWith('read secret failed: %s',
                'Vault request timed out after 1000 ms (api.timeout)');
            // The same client keeps working once Vault answers again.
            expect((await client.read('secret/ok')).getData()).to.deep.equal({ k: 'v' });
        });

        it('bounds a background renewal, logs it as failed and re-arms the timer', async function () {
            this.timeout(6000);
            const logger = createSpyLogger();
            client = new VaultClient({
                api: { url: `${baseUrl}/`, timeout: 1000 },
                logger,
                // A 10 s token renewed at 2% of its lifetime: renew-self is sent after ~200 ms.
                auth: { type: 'token', renewalFraction: 0.02, config: { token: 'tok' } },
            });

            await client.read('secret/ok');
            const failures = () => logger.error.getCalls()
                .filter((call) => call.args[0] === 'token renew failed: %s');
            const deadlineAt = Date.now() + 5000;
            while (failures().length < 2 && Date.now() < deadlineAt) {
                await delay(25);
            }

            // Two failed attempts: the first timed out, the timer was re-armed with the same
            // token, and the renewal was tried again rather than abandoned.
            expect(failures()).to.have.lengthOf.at.least(2);
            failures().forEach((call) => expect(call.args[1])
                .to.equal('Vault request timed out after 1000 ms (api.timeout)'));
        });

        it('wraps a mount detection that times out in VaultError, with RequestTimeoutError on cause', async function () {
            client = new VaultClient({
                api: { url: `${baseUrl}/`, timeout: 1000, kv: { autoDetect: true } },
                logger: false,
                auth: { type: 'token', renewal: false, config: { token: 'tok' } },
            });

            const { error } = await settle(client.read('secret/ok'));

            expect(error).to.be.instanceOf(errors.VaultError);
            expect(error.message).to.contain('Failed to detect KV engine version');
            expect(error.cause).to.be.instanceOf(errors.RequestTimeoutError);
        });
    });
});
