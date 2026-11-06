/**
 * A warning when `api.url` is plain http:// to a host off this machine (part of #202): the
 * token and secrets would cross the network unencrypted. The warning names the host only, is
 * logged once per host per process, and changes nothing else.
 */
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultClient from '../src/VaultClient.js';
import { createSpyLogger, loggedText } from './helpers/logger.mjs';

use(sinonChai);

const WARNING = '"api.url" uses plain http:// for %s, which is not a loopback address; the Vault token and '
    + 'secrets travel unencrypted. Use https:// unless the network path is protected otherwise';

// The warning is deduplicated for the whole process, so every test gets hosts of its own.
let seq = 0;
const host = (label = 'vault') => `${label}-${process.pid}-${Date.now().toString(36)}-${++seq}.example`;

function plainHttpWarnings(logger) {
    return logger.warn.getCalls().filter((c) => c.args[0] === WARNING);
}

describe('plain http:// warning for api.url', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('warns with the host and port only, never credentials or a path', function () {
        const logger = createSpyLogger();
        const name = host();
        new VaultApiClient({ url: `http://user:p4ssw0rd@${name}:8200/some/prefix?x=1` }, logger);

        const warnings = plainHttpWarnings(logger);
        expect(warnings).to.have.length(1);
        expect(warnings[0].args).to.deep.equal([WARNING, `${name}:8200`]);
        const text = loggedText(logger);
        expect(text).not.to.include('p4ssw0rd');
        expect(text).not.to.include('user');
        expect(text).not.to.include('/some/prefix');
    });

    it('warns for a plain IP address off this machine', function () {
        const logger = createSpyLogger();
        // An unroutable TEST-NET-1 address that no other test uses with a port this high.
        const port = 40000 + (process.pid % 20000);
        new VaultApiClient({ url: `http://192.0.2.10:${port}` }, logger);
        expect(plainHttpWarnings(logger).map((c) => c.args[1])).to.deep.equal([`192.0.2.10:${port}`]);
    });

    for (const url of [
        'http://localhost:8200',
        'http://LOCALHOST.:8200',
        'http://vault.localhost:8200',
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
        it(`does not warn for the loopback address ${url}`, function () {
            const logger = createSpyLogger();
            new VaultApiClient({ url }, logger);
            expect(logger.warn).not.to.have.been.called;
        });
    }

    it('does not warn for https://', function () {
        const logger = createSpyLogger();
        new VaultApiClient({ url: `https://${host()}:8200` }, logger);
        expect(logger.warn).not.to.have.been.called;
    });

    it('does not treat a host that only starts with 127 or localhost as loopback', function () {
        const logger = createSpyLogger();
        const lookalikes = [`127.0.0.1.${host('nip')}`, `localhost.${host('evil')}`, `${host('localhost')}`];
        for (const name of lookalikes) {
            new VaultApiClient({ url: `http://${name}:8200` }, logger);
        }
        expect(plainHttpWarnings(logger).map((c) => c.args[1])).to.deep.equal(lookalikes.map((n) => `${n}:8200`));
    });

    it('warns for IPv6 hosts that only look like the IPv4-mapped loopback range', function () {
        // Each is a remote address; a port of their own keeps them apart from other test runs.
        const port = 40000 + (process.pid % 20000) + 1;
        const urls = [
            `http://[::ffff:7f]:${port}`,
            `http://[0:0:0:ffff:7f00::1]:${port}`,
            `http://[::ffff:7fab:cdef:1234]:${port}`,
            `http://[::ffff:8000:1]:${port}`,
        ];
        const logger = createSpyLogger();
        for (const url of urls) {
            new VaultApiClient({ url }, logger);
        }
        expect(plainHttpWarnings(logger)).to.have.length(urls.length);
    });

    it('names the bare host for the default port 80', function () {
        const logger = createSpyLogger();
        const name = host();
        new VaultApiClient({ url: `http://${name}/` }, logger);
        new VaultApiClient({ url: `http://${name}:80/` }, logger);
        expect(plainHttpWarnings(logger).map((c) => c.args[1])).to.deep.equal([name]);
    });

    it('does not fail construction when the logger throws, and builds the same client', function () {
        const logger = createSpyLogger();
        logger.warn = () => {
            throw new Error('logger down');
        };
        const name = host();
        let api;
        expect(() => {
            api = new VaultApiClient({ url: `http://${name}:8200` }, logger);
        }).not.to.throw();
        expect(api.__config.url).to.equal(`http://${name}:8200`);
    });

    it('logs once per host for the whole process, however many clients use it', function () {
        const first = createSpyLogger();
        const second = createSpyLogger();
        const name = host();
        new VaultApiClient({ url: `http://${name}:8200` }, first);
        new VaultApiClient({ url: `http://${name}:8200/` }, first);
        new VaultApiClient({ url: `http://${name}:8200` }, second);

        expect(plainHttpWarnings(first)).to.have.length(1);
        expect(plainHttpWarnings(second), 'already warned in this process').to.have.length(0);
    });

    it('warns again for another host or port', function () {
        const logger = createSpyLogger();
        const a = host();
        const b = host();
        new VaultApiClient({ url: `http://${a}:8200` }, logger);
        new VaultApiClient({ url: `http://${a}:8201` }, logger);
        new VaultApiClient({ url: `http://${b}:8200` }, logger);

        expect(plainHttpWarnings(logger).map((c) => c.args[1])).to.deep.equal([`${a}:8200`, `${a}:8201`, `${b}:8200`]);
    });

    it('leaves an unparsable or missing url to fail where it is used, as before', function () {
        const logger = createSpyLogger();
        expect(() => new VaultApiClient({ url: 'not a url' }, logger)).not.to.throw();
        expect(() => new VaultApiClient({}, logger)).not.to.throw();
        expect(() => new VaultApiClient(undefined, logger)).not.to.throw();
        expect(logger.warn).not.to.have.been.called;
    });

    it('changes nothing about the request: same URL and options as without the warning', async function () {
        const logger = createSpyLogger();
        const name = host();
        const fetch = sinon.stub(globalThis, 'fetch').callsFake(async () => new Response('{"data":{}}', {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }));
        const api = new VaultApiClient({ url: `http://${name}:8200`, timeout: 0 }, logger);

        await api.makeRequest('GET', 'secret/a', null, { 'X-Vault-Token': 't' });
        // The same call against a loopback URL, which never warns, for comparison.
        const loopback = new VaultApiClient({ url: 'http://127.0.0.1:8200', timeout: 0 }, createSpyLogger());
        await loopback.makeRequest('GET', 'secret/a', null, { 'X-Vault-Token': 't' });

        expect(fetch).to.have.been.calledTwice;
        expect(String(fetch.firstCall.args[0])).to.equal(`http://${name}:8200/v1/secret/a`);
        expect(fetch.firstCall.args[1]).to.deep.equal(fetch.secondCall.args[1]);
    });

    describe('through VaultClient', function () {
        it('goes to the configured logger', function () {
            const logger = createSpyLogger();
            const name = host();
            new VaultClient({
                api: { url: `http://${name}:8200` },
                logger,
                auth: { type: 'token', config: { token: 't' } },
            });
            expect(plainHttpWarnings(logger).map((c) => c.args[1])).to.deep.equal([`${name}:8200`]);
        });

        it('goes to console.warn with the default logger', function () {
            const warn = sinon.stub(console, 'warn');
            const name = host();
            new VaultClient({
                api: { url: `http://${name}:8200` },
                auth: { type: 'token', config: { token: 't' } },
            });
            expect(warn.getCalls().filter((c) => c.args[0] === WARNING).map((c) => c.args[1])).to.deep.equal([`${name}:8200`]);
        });

        it('is silent with logger: false', function () {
            const warn = sinon.stub(console, 'warn');
            new VaultClient({
                api: { url: `http://${host()}:8200` },
                logger: false,
                auth: { type: 'token', config: { token: 't' } },
            });
            expect(warn).not.to.have.been.called;
        });
    });
});
