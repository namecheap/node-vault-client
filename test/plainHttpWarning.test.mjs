/**
 * A warning when `api.url` is plain http:// to a host off this machine (part of #202): the
 * token and secrets would cross the network unencrypted. The warning names the host only, is
 * logged on a client's first request, once per host and port for each logger (the default
 * console logger is shared, so once per process), and changes nothing else.
 */
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultClient from '../src/VaultClient.js';
import { createSpyLogger } from './helpers/logger.mjs';

use(sinonChai);

const WARNING = '"api.url" uses plain http:// for %s, which is not a loopback address; the Vault token and '
    + 'secrets travel unencrypted. Use https:// unless the network path is protected otherwise';

// The warning is deduplicated for the whole process, so every test gets hosts of its own.
let seq = 0;
const host = (label = 'vault') => `${label}-${process.pid}-${Date.now().toString(36)}-${++seq}.example`;
// A port of this run's own for literal addresses that cannot be made unique by name.
const PORT = 40000 + (process.pid % 20000);

function plainHttpWarnings(logger) {
    return logger.warn.getCalls().filter((c) => c.args[0] === WARNING);
}

describe('plain http:// warning for api.url', function () {
    let fetch;

    beforeEach(function () {
        fetch = sinon.stub(globalThis, 'fetch').callsFake(async () => new Response('{"data":{}}', {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }));
    });

    afterEach(function () {
        sinon.restore();
    });

    /** Build a client for `url` and send its first request; a rejected request is fine here. */
    async function firstRequest(url, logger) {
        const api = new VaultApiClient({ url, timeout: 0 }, logger);
        await api.makeRequest('GET', 'sys/health', null, {}).catch(() => {});
        return api;
    }

    it('warns on the first request, with the host and port only, never credentials or a path', async function () {
        const logger = createSpyLogger();
        const name = host();
        const api = new VaultApiClient({ url: `http://user:p4ssw0rd@${name}:8200/some/prefix?x=1`, timeout: 0 }, logger);
        expect(logger.warn, 'nothing at construction').not.to.have.been.called;

        await api.makeRequest('GET', 'sys/health', null, {});

        const warnings = plainHttpWarnings(logger);
        expect(warnings).to.have.length(1);
        expect(warnings[0].args).to.deep.equal([WARNING, `${name}:8200`]);
        // Only the warning's own arguments: the request's existing debug lines are out of scope.
        const text = warnings[0].args.join(' ');
        expect(text).not.to.include('p4ssw0rd');
        expect(text).not.to.include('user');
        expect(text).not.to.include('/some/prefix');
    });

    it('warns for a plain IP address off this machine', async function () {
        const logger = createSpyLogger();
        await firstRequest(`http://192.0.2.10:${PORT}`, logger);
        expect(plainHttpWarnings(logger).map((c) => c.args[1])).to.deep.equal([`192.0.2.10:${PORT}`]);
    });

    for (const url of [
        'http://localhost:8200',
        'http://LOCALHOST.:8200',
        'http://127.0.0.1:8200',
        'http://127.1:8200',
        'http://127.255.0.9',
        'http://0x7f000001:8200',
        'http://[::1]:8200',
        'http://[0:0:0:0:0:0:0:1]:8200',
        'http://[::ffff:127.0.0.1]:8200',
        'http://[::ffff:127.200.3.4]:8200',
        'http://0.0.0.0:8200',
        'http://[::]:8200',
    ]) {
        it(`does not warn for the loopback address ${url}`, async function () {
            const logger = createSpyLogger();
            await firstRequest(url, logger);
            expect(logger.warn).not.to.have.been.called;
        });
    }

    it('does not warn for https://', async function () {
        const logger = createSpyLogger();
        await firstRequest(`https://${host()}:8200`, logger);
        expect(logger.warn).not.to.have.been.called;
    });

    it('does not treat a host that only starts with 127 or localhost as loopback', async function () {
        const logger = createSpyLogger();
        // A localhost subdomain goes through the system resolver, which can send it anywhere.
        const lookalikes = [`127.0.0.1.${host('nip')}`, `localhost.${host('evil')}`, `${host('localhost')}`,
            `${host('vault')}.localhost`];
        for (const name of lookalikes) {
            await firstRequest(`http://${name}:8200`, logger);
        }
        expect(plainHttpWarnings(logger).map((c) => c.args[1])).to.deep.equal(lookalikes.map((n) => `${n}:8200`));
    });

    it('warns for IPv6 hosts that only look like the IPv4-mapped loopback range', async function () {
        const port = PORT + 1;
        const urls = [
            `http://[::ffff:7f]:${port}`,
            `http://[0:0:0:ffff:7f00::1]:${port}`,
            `http://[::ffff:7fab:cdef:1234]:${port}`,
            `http://[::ffff:8000:1]:${port}`,
        ];
        const logger = createSpyLogger();
        for (const url of urls) {
            await firstRequest(url, logger);
        }
        expect(plainHttpWarnings(logger)).to.have.length(urls.length);
    });

    it('names the bare host for the default port 80', async function () {
        const logger = createSpyLogger();
        const name = host();
        await firstRequest(`http://${name}/`, logger);
        await firstRequest(`http://${name}:80/`, logger);
        expect(plainHttpWarnings(logger).map((c) => c.args[1])).to.deep.equal([name]);
    });

    it('warns once per host for a logger, however many clients share it', async function () {
        const shared = createSpyLogger();
        const name = host();
        const api = await firstRequest(`http://${name}:8200`, shared);
        await api.makeRequest('GET', 'sys/health', null, {});
        await firstRequest(`http://${name}:8200/`, shared);

        expect(plainHttpWarnings(shared)).to.have.length(1);
    });

    it('warns a logger of its own even when another logger was warned for that host', async function () {
        const first = createSpyLogger();
        const second = createSpyLogger();
        const name = host();
        await firstRequest(`http://${name}:8200`, first);
        await firstRequest(`http://${name}:8200`, second);

        expect(plainHttpWarnings(first)).to.have.length(1);
        expect(plainHttpWarnings(second)).to.have.length(1);
    });

    it('warns again for another host or port', async function () {
        const logger = createSpyLogger();
        const a = host();
        await firstRequest(`http://${a}:8200`, logger);
        await firstRequest(`http://${a}:8201`, logger);
        await firstRequest(`http://${host()}:8200`, logger);

        expect(plainHttpWarnings(logger)).to.have.length(3);
    });

    it('does not fail the request when the logger throws, and warns once a logger works', async function () {
        const throwing = createSpyLogger();
        throwing.warn = () => {
            throw new Error('logger down');
        };
        const name = host();
        const api = new VaultApiClient({ url: `http://${name}:8200`, timeout: 0 }, throwing);
        expect(await api.makeRequest('GET', 'sys/health', null, {})).to.deep.equal({ data: {} });

        const logger = createSpyLogger();
        await firstRequest(`http://${name}:8200`, logger);
        expect(plainHttpWarnings(logger), 'the throwing logger did not use it up').to.have.length(1);
    });

    it('tries again on the same client\'s next request after its logger threw', async function () {
        const logger = createSpyLogger();
        const warn = logger.warn;
        let calls = 0;
        logger.warn = function (...args) {
            calls++;
            if (calls === 1) {
                throw new Error('logger down');
            }
            return warn.apply(this, args);
        };
        const api = await firstRequest(`http://${host()}:8200`, logger);
        await api.makeRequest('GET', 'sys/health', null, {});
        await api.makeRequest('GET', 'sys/health', null, {});

        expect(calls, 'one failed attempt, one logged warning, then nothing').to.equal(2);
        expect(plainHttpWarnings({ warn })).to.have.length(1);
    });

    it('leaves an unparsable or missing url to fail where it is used, as before', async function () {
        const logger = createSpyLogger();
        expect(() => new VaultApiClient({ url: 'not a url' }, logger)).not.to.throw();
        expect(() => new VaultApiClient({}, logger)).not.to.throw();
        expect(() => new VaultApiClient(undefined, logger)).not.to.throw();
        await firstRequest('not a url', logger);
        expect(logger.warn).not.to.have.been.called;
    });

    it('changes nothing about the request: same URL and options as a loopback client', async function () {
        const logger = createSpyLogger();
        const name = host();
        const api = new VaultApiClient({ url: `http://${name}:8200`, timeout: 0 }, logger);
        await api.makeRequest('GET', 'secret/a', null, { 'X-Vault-Token': 't' });
        const loopback = new VaultApiClient({ url: 'http://127.0.0.1:8200', timeout: 0 }, createSpyLogger());
        await loopback.makeRequest('GET', 'secret/a', null, { 'X-Vault-Token': 't' });

        expect(fetch).to.have.been.calledTwice;
        expect(String(fetch.firstCall.args[0])).to.equal(`http://${name}:8200/v1/secret/a`);
        expect(fetch.firstCall.args[1]).to.deep.equal(fetch.secondCall.args[1]);
        expect(plainHttpWarnings(logger)).to.have.length(1);
    });

    describe('through VaultClient', function () {
        const tokenAuth = { type: 'token', renewal: false, config: { token: 't' } };

        it('goes to the configured logger on the first request', async function () {
            const logger = createSpyLogger();
            const name = host();
            const client = new VaultClient({ api: { url: `http://${name}:8200`, timeout: 0 }, logger, auth: tokenAuth });
            expect(logger.warn).not.to.have.been.called;
            await client.request('GET', 'sys/health').catch(() => {});
            expect(plainHttpWarnings(logger).map((c) => c.args[1])).to.deep.equal([`${name}:8200`]);
        });

        it('does not warn for a client whose construction fails after building the api client', function () {
            const logger = createSpyLogger();
            expect(() => new VaultClient({
                api: { url: `http://${host()}:8200` },
                logger,
                auth: { type: 'token', renewal: 'false', config: { token: 't' } },
            })).to.throw();
            expect(logger.warn).not.to.have.been.called;
        });

        it('goes to console.warn with the default logger', async function () {
            const warn = sinon.stub(console, 'warn');
            sinon.stub(console, 'info');
            sinon.stub(console, 'debug');
            const name = host();
            const client = new VaultClient({ api: { url: `http://${name}:8200`, timeout: 0 }, auth: tokenAuth });
            await client.request('GET', 'sys/health').catch(() => {});
            expect(warn.getCalls().filter((c) => c.args[0] === WARNING).map((c) => c.args[1])).to.deep.equal([`${name}:8200`]);
        });

        it('warns once per process with the default logger, however many clients there are', async function () {
            const warn = sinon.stub(console, 'warn');
            sinon.stub(console, 'info');
            sinon.stub(console, 'debug');
            const url = `http://${host()}:8200`;
            for (let i = 0; i < 3; i++) {
                const client = new VaultClient({ api: { url, timeout: 0 }, auth: tokenAuth });
                await client.request('GET', 'sys/health').catch(() => {});
            }
            expect(warn.getCalls().filter((c) => c.args[0] === WARNING)).to.have.length(1);
        });

        it('is silent with logger: false, and does not use up the warning for other clients', async function () {
            const warn = sinon.stub(console, 'warn');
            const url = `http://${host()}:8200`;
            const silent = new VaultClient({ api: { url, timeout: 0 }, logger: false, auth: tokenAuth });
            await silent.request('GET', 'sys/health').catch(() => {});
            expect(warn).not.to.have.been.called;

            const logger = createSpyLogger();
            const client = new VaultClient({ api: { url, timeout: 0 }, logger, auth: tokenAuth });
            await client.request('GET', 'sys/health').catch(() => {});
            expect(plainHttpWarnings(logger)).to.have.length(1);
        });
    });
});
