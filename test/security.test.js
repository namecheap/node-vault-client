'use strict';

/**
 * Secret material must not reach the logger (issue #204, GHSA-x5xf-r8x2-647h,
 * GHSA-2vr8-g4vw-7xpm), and thrown errors must not print the token. A local HTTP stub stands in
 * for Vault so the real request/request-promise stack, and the errors it builds, are exercised.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const util = require('util');

const lt = require('long-timeout');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;

const VaultClient = require('../src/VaultClient');
const VaultApiClient = require('../src/VaultApiClient');
const errors = require('../src/errors');
const safeMessage = require('../src/safeMessage');
const { StatusCodeError, RequestError } = require('request-promise/errors');

const CLIENT_TOKEN = 'CLIENT-TOKEN-SECRET-0001';
const PLAINTEXT = 'PLAINTEXT-SECRET-0002';

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function lookupBody(overrides) {
    return {
        data: Object.assign({
            id: CLIENT_TOKEN,
            accessor: 'acc-123',
            creation_time: nowSeconds(),
            ttl: 3600,
            renewable: false,
        }, overrides || {}),
    };
}

/**
 * Starts a stub Vault. `routes` maps "<METHOD> <path>" (path without /v1) to [status, body]
 * or a function returning one; anything else answers 200 with a KV read body.
 */
function startStub(routes) {
    return new Promise((resolve) => {
        const requests = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                const route = `${req.method} ${req.url.replace(/^\/v1/, '')}`;
                requests.push({ route, headers: req.headers, body });
                let answer = routes[route];
                if (typeof answer === 'function') answer = answer();
                if (answer === undefined) {
                    answer = route.endsWith('/login')
                        ? [200, { auth: { client_token: CLIENT_TOKEN, accessor: 'acc-123' } }]
                        : [200, { data: { password: 'stored' } }];
                }
                res.writeHead(answer[0], { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(answer[1]));
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({
            requests,
            url: `http://127.0.0.1:${server.address().port}/`,
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}

/** A five-method logger that records every call, formatted the way a real logger prints it. */
function recordingLogger() {
    const lines = [];
    const logger = {};
    ['error', 'warn', 'info', 'debug', 'trace'].forEach((level) => {
        logger[level] = function () {
            const args = Array.prototype.slice.call(arguments);
            lines.push(`${level}: ${util.format.apply(util, args)} ${util.inspect(args, { depth: 6 })}`);
        };
    });
    return { logger, text: () => lines.join('\n') };
}

/** Records the default logger's console output while `fn` runs. */
async function captureConsole(fn) {
    const lines = [];
    const saved = {};
    ['error', 'warn', 'info', 'trace', 'log'].forEach((m) => {
        saved[m] = console[m];
        console[m] = function () {
            lines.push(util.format.apply(util, arguments));
        };
    });
    try {
        await fn();
    } finally {
        Object.keys(saved).forEach((m) => { console[m] = saved[m]; });
    }
    return lines.join('\n');
}

async function rejection(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected a rejection');
}

describe('Secret material in logs and errors', function () {
    let stub;

    afterEach(async function () {
        if (stub) {
            await stub.close();
            stub = null;
        }
    });

    describe('debug logging (#204)', function () {
        it('VaultApiClient logs neither response bodies nor the token', async function () {
            stub = await startStub({ 'GET /secret/x': [200, { auth: { client_token: CLIENT_TOKEN }, data: { password: PLAINTEXT } }] });
            const rec = recordingLogger();
            const api = new VaultApiClient({ url: stub.url }, rec.logger);

            const body = await api.makeRequest('GET', 'secret/x', null, { 'X-Vault-Token': 'HEADER-TOKEN-SECRET' });

            expect(body.data.password).to.equal(PLAINTEXT);
            expect(rec.text()).to.include('GET');
            expect(rec.text()).to.not.include(PLAINTEXT);
            expect(rec.text()).to.not.include(CLIENT_TOKEN);
            expect(rec.text()).to.not.include('HEADER-TOKEN-SECRET');
        });

        [
            ['with secret_id', { role_id: 'ROLE-ID-SECRET', secret_id: 'SECRET-ID-SECRET' }],
            ['role_id only', { role_id: 'ROLE-ID-SECRET' }],
        ].forEach(([label, config]) => {
            it(`AppRole never logs role_id, secret_id or the client token (${label}, GHSA-x5xf-r8x2-647h)`, async function () {
                stub = await startStub({ 'GET /auth/token/lookup-self': [200, lookupBody()] });
                const rec = recordingLogger();
                const client = new VaultClient({ api: { url: stub.url }, auth: { type: 'appRole', config }, logger: rec.logger });

                await client.read('secret/x');

                const login = stub.requests.find((r) => r.route === 'POST /auth/approle/login');
                expect(JSON.parse(login.body).role_id).to.equal('ROLE-ID-SECRET');
                expect(rec.text()).to.include('approle mount=approle');
                expect(rec.text()).to.include('accessor=acc-123');
                ['ROLE-ID-SECRET', 'SECRET-ID-SECRET', CLIENT_TOKEN].forEach((secret) => {
                    expect(rec.text(), secret).to.not.include(secret);
                });
            });
        });

        it('Kubernetes logs the JWT path and size, never the JWT or the client token', async function () {
            const jwt = 'K8S-JWT-SECRET.payload.signature';
            const tokenPath = path.join(os.tmpdir(), `k8s-jwt-${Date.now()}-${process.pid}`);
            fs.writeFileSync(tokenPath, jwt);
            try {
                stub = await startStub({ 'GET /auth/token/lookup-self': [200, lookupBody()] });
                const rec = recordingLogger();
                const client = new VaultClient({ api: { url: stub.url }, auth: { type: 'kubernetes', config: { role: 'r', tokenPath } }, logger: rec.logger });

                await client.read('secret/x');

                expect(rec.text()).to.include(`(${jwt.length} bytes)`);
                expect(rec.text()).to.not.include('K8S-JWT-SECRET');
                expect(rec.text()).to.not.include(CLIENT_TOKEN);
            } finally {
                fs.unlinkSync(tokenPath);
            }
        });

        it('IAM never logs the client token or the AWS credentials', async function () {
            stub = await startStub({ 'GET /auth/token/lookup-self': [200, lookupBody()] });
            const rec = recordingLogger();
            const credentials = { accessKeyId: 'AKIDSECRET000000001', secretAccessKey: 'IAM-SECRET-ACCESS-KEY', sessionToken: 'IAM-SESSION-TOKEN' };
            const client = new VaultClient({ api: { url: stub.url }, auth: { type: 'iam', config: { role: 'r', credentials } }, logger: rec.logger });

            await client.read('secret/x');

            expect(rec.text()).to.include('accessor=acc-123');
            [CLIENT_TOKEN, 'AKIDSECRET000000001', 'IAM-SECRET-ACCESS-KEY', 'IAM-SESSION-TOKEN'].forEach((secret) => {
                expect(rec.text(), secret).to.not.include(secret);
            });
        });

        it('the refresh-timer line names the accessor, not the token', async function () {
            stub = await startStub({ 'GET /auth/token/lookup-self': [200, lookupBody({ renewable: true })] });
            const rec = recordingLogger();
            const client = new VaultClient({ api: { url: stub.url }, auth: { type: 'token', config: { token: CLIENT_TOKEN } }, logger: rec.logger });
            try {
                await client.read('secret/x');
            } finally {
                lt.clearTimeout(client.__auth.__refreshTimeout);
            }

            expect(rec.text()).to.include('setting refresh timer for token (accessor=acc-123)');
            expect(rec.text()).to.not.include(CLIENT_TOKEN);
        });
    });

    describe('error logs (GHSA-2vr8-g4vw-7xpm)', function () {
        it('safeMessage keeps only the status and Vault\'s errors strings', function () {
            const withErrors = new StatusCodeError(400, { errors: ['bad item', 7], data: { batch_results: [{ plaintext: PLAINTEXT }] } }, {}, {});
            expect(safeMessage(withErrors)).to.equal('400 - {"errors":["bad item"]}');
            expect(safeMessage(new StatusCodeError(404, { data: { plaintext: PLAINTEXT } }, {}, {}))).to.equal('404 - (response body omitted)');
            expect(safeMessage(new StatusCodeError(502, `<html>${PLAINTEXT}</html>`, {}, {}))).to.equal('502 - (response body omitted)');
            expect(safeMessage(new RequestError(new Error('connect ECONNREFUSED'), {}, {}))).to.equal('Error: connect ECONNREFUSED');
            expect(safeMessage(new Error('plain'))).to.equal('plain');
            expect(safeMessage(undefined)).to.equal('undefined');
        });

        [
            ['read', (c) => c.read('transit/decrypt/k')],
            ['list', (c) => c.list('secret/')],
            ['write', (c) => c.write('transit/decrypt/k', { batch_input: [{ ciphertext: 'vault:v1:x' }] })],
        ].forEach(([name, call]) => {
            it(`${name}() logs the status and errors, not the response body; the thrown error is unchanged`, async function () {
                const failure = [400, { errors: ['1 error occurred: cipher: message authentication failed'], data: { batch_results: [{ plaintext: PLAINTEXT }] } }];
                stub = await startStub({
                    'GET /auth/token/lookup-self': [200, lookupBody()],
                    'GET /transit/decrypt/k': failure,
                    'POST /transit/decrypt/k': failure,
                });
                let err;
                // The default logger binds console.error when the client is built.
                const output = await captureConsole(async () => {
                    const client = new VaultClient({ api: { url: stub.url }, auth: { type: 'token', config: { token: CLIENT_TOKEN } } });
                    if (name === 'list') {
                        // Node's HTTP server answers the LIST method with its own 400, so the
                        // Vault error is injected at the request layer instead.
                        sinon.stub(client.__api, 'makeRequest').callsFake(function (method) {
                            return method === 'LIST'
                                ? Promise.reject(new StatusCodeError(failure[0], failure[1], {}, {}))
                                : VaultApiClient.prototype.makeRequest.apply(client.__api, arguments);
                        });
                    }
                    err = await rejection(call(client));
                });

                expect(output).to.include('400 - {"errors":["1 error occurred: cipher: message authentication failed"]}');
                expect(output).to.not.include(PLAINTEXT);
                expect(err).to.be.instanceOf(StatusCodeError);
                expect(err.message).to.include(PLAINTEXT);
            });
        });

        it('mount detection failure does not embed the response body', async function () {
            stub = await startStub({
                'GET /auth/token/lookup-self': [200, lookupBody()],
                'GET /sys/internal/ui/mounts/secret/x': [400, { data: { plaintext: PLAINTEXT } }],
            });
            let err;
            const output = await captureConsole(async () => {
                const client = new VaultClient({ api: { url: stub.url, kv: { autoDetect: true } }, auth: { type: 'token', config: { token: CLIENT_TOKEN } } });
                err = await rejection(client.read('secret/x'));
            });

            expect(err).to.be.instanceOf(errors.VaultError);
            expect(err.message).to.include('400 - (response body omitted)');
            expect(err.message).to.not.include(PLAINTEXT);
            expect(output).to.not.include(PLAINTEXT);
        });

        it('a failed background renewal logs the safe message only: no token, no body', async function () {
            this.timeout(5000);
            stub = await startStub({
                'GET /auth/token/lookup-self': [200, lookupBody({ ttl: 2, renewable: true })],
                'POST /auth/token/renew-self': [400, { data: { plaintext: PLAINTEXT } }],
            });
            let client;
            const output = await captureConsole(async () => {
                client = new VaultClient({ api: { url: stub.url }, auth: { type: 'token', config: { token: CLIENT_TOKEN } } });
                try {
                    await client.read('secret/x');
                    // The refresh timer fires at half of the remaining 2 s.
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                } finally {
                    lt.clearTimeout(client.__auth.__refreshTimeout);
                }
            });

            expect(output).to.include('Cannot refresh auth token with "acc-123" accessor. Error: 400 - (response body omitted)');
            expect(output).to.include('token renew failed: 400 - (response body omitted)');
            expect(output).to.not.include(CLIENT_TOKEN);
            expect(output).to.not.include(PLAINTEXT);
        });
    });

    describe('thrown errors', function () {
        it('a StatusCodeError no longer prints the token or the request body, but keeps its fields', async function () {
            stub = await startStub({ 'POST /secret/x': [403, { errors: ['permission denied'] }] });
            const api = new VaultApiClient({ url: stub.url }, recordingLogger().logger);

            const err = await rejection(api.makeRequest('POST', 'secret/x', { password: 'REQUEST-BODY-SECRET' }, { 'X-Vault-Token': CLIENT_TOKEN }));

            expect(err).to.be.instanceOf(StatusCodeError);
            expect(err.statusCode).to.equal(403);
            expect(err.error).to.deep.equal({ errors: ['permission denied'] });
            expect(err.options.headers['X-Vault-Token']).to.equal(CLIENT_TOKEN);
            expect(err.response.statusCode).to.equal(403);
            for (const printed of [util.inspect(err, { depth: 10 }), JSON.stringify(err)]) {
                expect(printed).to.not.include(CLIENT_TOKEN);
                expect(printed).to.not.include('REQUEST-BODY-SECRET');
            }
        });

        it('a RequestError (network failure) no longer prints the token', async function () {
            const api = new VaultApiClient({ url: 'http://127.0.0.1:1/' }, recordingLogger().logger);

            const err = await rejection(api.makeRequest('GET', 'secret/x', null, { 'X-Vault-Token': CLIENT_TOKEN }));

            expect(err).to.be.instanceOf(RequestError);
            expect(err.options.headers['X-Vault-Token']).to.equal(CLIENT_TOKEN);
            expect(util.inspect(err, { depth: 10 })).to.not.include(CLIENT_TOKEN);
        });
    });
});
