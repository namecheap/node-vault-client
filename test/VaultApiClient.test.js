'use strict';

const http = require('http');
const _ = require('lodash');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const VaultApiClient = require('../src/VaultApiClient');

const logger = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (prop) => [prop, _.noop]));

describe('VaultApiClient', function () {
    let server;
    let baseUrl;
    let lastRequest;
    let responder;

    before(function (done) {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                lastRequest = {
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    body: body,
                };
                responder(req, res);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            done();
        });
    });

    after(function (done) {
        // fetch (undici) keeps sockets alive in a pool; drop them so close() returns
        server.closeAllConnections();
        server.close(done);
    });

    beforeEach(function () {
        lastRequest = null;
        responder = (req, res) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, echoMethod: req.method }));
        };
    });

    describe('#makeRequest()', function () {
        it('defaults the api version to v1 and joins the url segments', function () {
            const api = new VaultApiClient({ url: baseUrl }, logger);
            return api.makeRequest('GET', '/secret/foo').then((res) => {
                expect(res).to.deep.equal({ ok: true, echoMethod: 'GET' });
                expect(lastRequest.url).to.equal('/v1/secret/foo');
            });
        });

        it('honours a custom api version', function () {
            const api = new VaultApiClient({ url: baseUrl, apiVersion: 'v2' }, logger);
            return api.makeRequest('GET', 'secret/foo').then(() => {
                expect(lastRequest.url).to.equal('/v2/secret/foo');
            });
        });

        it('sends the payload as JSON on a POST', function () {
            const api = new VaultApiClient({ url: baseUrl }, logger);
            return api.makeRequest('POST', '/secret/foo', { hello: 'world' }, { 'X-Vault-Token': 'tok' }).then(() => {
                expect(lastRequest.method).to.equal('POST');
                expect(JSON.parse(lastRequest.body)).to.deep.equal({ hello: 'world' });
                expect(lastRequest.headers['x-vault-token']).to.equal('tok');
            });
        });

        it('sends no body when data is undefined', function () {
            const api = new VaultApiClient({ url: baseUrl }, logger);
            return api.makeRequest('GET', '/secret/foo').then(() => {
                expect(lastRequest.body).to.equal('');
            });
        });

        it('sends no body when data is null', function () {
            const api = new VaultApiClient({ url: baseUrl }, logger);
            return api.makeRequest('POST', '/secret/foo', null).then(() => {
                expect(lastRequest.body).to.equal('');
            });
        });

        it('logs the request and the response body via the debug logger', function () {
            const debug = sinon.spy();
            const api = new VaultApiClient({ url: baseUrl }, _.assign({}, logger, { debug }));
            return api.makeRequest('GET', '/secret/foo').then(() => {
                expect(debug).to.have.been.calledWith('making request: %s %s', 'GET', `${baseUrl}/v1/secret/foo`);
                // second debug call logs the response body
                expect(debug.callCount).to.be.at.least(2);
            });
        });

        it('does not mutate the config object passed in', function () {
            const config = { url: baseUrl };
            const api = new VaultApiClient(config, logger);
            expect(config).to.not.have.property('apiVersion');
            return api.makeRequest('GET', '/secret/foo');
        });

        it('rejects when the server responds with a non-2xx status', function () {
            responder = (req, res) => {
                res.statusCode = 500;
                res.end('boom');
            };
            const api = new VaultApiClient({ url: baseUrl }, logger);
            return api.makeRequest('GET', '/secret/foo').then(
                () => { throw new Error('expected rejection'); },
                (err) => { expect(err.statusCode).to.equal(500); }
            );
        });

        it('merges config.requestOptions.headers, with per-request headers taking precedence', function () {
            const api = new VaultApiClient({
                url: baseUrl,
                requestOptions: { headers: { 'X-Custom': 'from-config', 'X-Vault-Token': 'config-tok' } },
            }, logger);
            return api.makeRequest('GET', '/secret/foo', null, { 'X-Vault-Token': 'call-tok' }).then(() => {
                expect(lastRequest.headers['x-custom']).to.equal('from-config');
                expect(lastRequest.headers['x-vault-token']).to.equal('call-tok');
                expect(lastRequest.headers['accept']).to.equal('application/json');
            });
        });

        it('forwards config.requestOptions (e.g. a custom dispatcher) into the fetch call', function () {
            const dispatcher = { __sentinel: 'my-dispatcher' };
            const fetchStub = sinon.stub(global, 'fetch').resolves(
                new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
            );
            const api = new VaultApiClient({ url: baseUrl, requestOptions: { dispatcher } }, logger);
            return api.makeRequest('GET', '/secret/foo').then((res) => {
                expect(res).to.deep.equal({ ok: true });
                expect(fetchStub).to.have.been.calledOnce;
                const options = fetchStub.firstCall.args[1];
                expect(options.dispatcher).to.equal(dispatcher);
                // request semantics still win over requestOptions
                expect(options.method).to.equal('GET');
                expect(options.headers.Accept).to.equal('application/json');
            }).finally(() => fetchStub.restore());
        });

        it('keeps a live requestOptions.dispatcher by reference (does not deep-clone it)', function () {
            const dispatcher = { __sentinel: true };
            const api = new VaultApiClient({ url: baseUrl, requestOptions: { dispatcher } }, logger);
            expect(api.__config.requestOptions.dispatcher).to.equal(dispatcher);
        });
    });
});
