/**
 * A warning when an IAM login is configured without `iam_server_id_header_value` (part of
 * #202): the signed STS request then names no Vault server and could be replayed to another
 * one that trusts the same AWS principal. Logged on the first login, once per Vault server,
 * namespace and mount for each logger (once per process on the default logger); nothing else
 * changes, including the login request itself.
 */
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultClient from '../src/VaultClient.js';
import VaultIAMAuth from '../src/auth/VaultIAMAuth.js';
import { createNoopLogger, createSpyLogger } from './helpers/logger.mjs';

use(sinonChai);

const WARNING = 'IAM login on mount "%s" is not configured with "iam_server_id_header_value", so the signed '
    + 'STS request names no Vault server and could be replayed to another one that trusts the same '
    + 'AWS principal. Set it to the same value as iam_server_id_header_value on auth/%s/config/client';

const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

// The warning is deduplicated for the whole process, so every test gets mounts of its own.
let seq = 0;
const mount = () => `aws-${process.pid}-${Date.now().toString(36)}-${++seq}`;

function serverIdWarnings(logger) {
    return logger.warn.getCalls().filter((c) => c.args[0] === WARNING);
}

const answerLogin = (method, path) => Promise.resolve(path.endsWith('/login')
    ? { auth: { client_token: 't', accessor: 'a' } }
    : { data: { id: 't', accessor: 'a', ttl: 60, renewable: false } });

/** A stub VaultApiClient that answers the IAM login and the lookup-self that follows it. */
function loginApi(url, namespace) {
    const api = sinon.createStubInstance(VaultApiClient);
    if (url !== undefined) {
        Object.assign(api, { __config: { url }, __namespace: namespace });
    }
    api.makeRequest.callsFake(answerLogin);
    return api;
}

function iamAuth(logger, config, mountName, api = loginApi()) {
    return new VaultIAMAuth(api, logger, Object.assign({ role: 'r', credentials: CREDENTIALS }, config), mountName);
}

async function login(logger, config, mountName, api) {
    const auth = iamAuth(logger, config, mountName, api);
    await auth._authenticate();
    return auth;
}

describe('IAM iam_server_id_header_value warning', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('warns on the first login, naming the mount, when the value is not configured', async function () {
        const logger = createSpyLogger();
        const name = mount();
        const auth = iamAuth(logger, {}, name);
        expect(logger.warn, 'nothing at construction').not.to.have.been.called;

        await auth._authenticate();

        expect(serverIdWarnings(logger).map((c) => c.args)).to.deep.equal([[WARNING, name, name]]);
    });

    it('warns for an empty value, which sends no header either', async function () {
        const logger = createSpyLogger();
        await login(logger, { iam_server_id_header_value: '' }, mount());
        expect(serverIdWarnings(logger)).to.have.length(1);
    });

    it('warns for a value of only whitespace, which is sent but names no server', async function () {
        const logger = createSpyLogger();
        const api = loginApi();
        await login(logger, { iam_server_id_header_value: ' \n' }, mount(), api);
        expect(serverIdWarnings(logger)).to.have.length(1);
        const headers = JSON.parse(Buffer.from(api.makeRequest.firstCall.args[2].iam_request_headers, 'base64').toString());
        expect(headers['X-Vault-AWS-IAM-Server-ID'], 'still sent as before').to.deep.equal([' \n']);
    });

    it('does not warn when the value is configured', async function () {
        const logger = createSpyLogger();
        await login(logger, { iam_server_id_header_value: 'vault.example.com' }, mount());
        expect(logger.warn).not.to.have.been.called;
    });

    it('sends a truthy non-string value as before, without a warning', async function () {
        const logger = createSpyLogger();
        await login(logger, { iam_server_id_header_value: 42 }, mount());
        expect(logger.warn).not.to.have.been.called;
    });

    it('logs once for a logger, however many logins and backends share it', async function () {
        const shared = createSpyLogger();
        const name = mount();
        const auth = await login(shared, {}, name);
        await auth._authenticate();
        await login(shared, {}, name);

        expect(serverIdWarnings(shared)).to.have.length(1);
    });

    it('warns a logger of its own even when another logger was warned for that mount', async function () {
        const first = createSpyLogger();
        const second = createSpyLogger();
        const name = mount();
        await login(first, {}, name);
        await login(second, {}, name);

        expect(serverIdWarnings(first)).to.have.length(1);
        expect(serverIdWarnings(second)).to.have.length(1);
    });

    it('treats spellings of one Vault URL as the same server', async function () {
        const logger = createSpyLogger();
        const name = mount();
        for (const url of ['https://vault.example.com:8200', 'https://vault.example.com:8200/', 'https://VAULT.example.com:8200//']) {
            await login(logger, {}, name, loginApi(url, 'ns'));
        }
        expect(serverIdWarnings(logger)).to.have.length(1);
    });

    it('warns separately for another mount, namespace or Vault server', async function () {
        const logger = createSpyLogger();
        const a = mount();
        const b = mount();
        await login(logger, {}, a, loginApi('https://a.example:8200', 'ns1'));
        await login(logger, {}, a, loginApi('https://a.example:8200', 'ns1'));
        await login(logger, {}, a, loginApi('https://a.example:8200', 'ns2'));
        await login(logger, {}, a, loginApi('https://b.example:8200', 'ns1'));
        await login(logger, {}, a, loginApi('https://a.example:8200', undefined));
        await login(logger, {}, b, loginApi('https://a.example:8200', 'ns1'));

        expect(serverIdWarnings(logger)).to.have.length(5);
    });

    it('logs nothing for a config the constructor rejects, nor for a backend that never logs in', async function () {
        const logger = createSpyLogger();
        const name = mount();
        expect(() => iamAuth(logger, { credentials: { accessKeyId: 'AKIDEXAMPLE' } }, name)).to.throw();
        iamAuth(logger, {}, name);
        expect(logger.warn).not.to.have.been.called;

        await login(logger, {}, name);
        expect(serverIdWarnings(logger), 'the first real login still warns').to.have.length(1);
    });

    it('does not fail the login when the logger throws, and warns once a logger works', async function () {
        const throwing = createNoopLogger();
        throwing.warn = () => {
            throw new Error('logger down');
        };
        const name = mount();
        const token = await iamAuth(throwing, {}, name)._authenticate();
        expect(token.getId()).to.equal('t');

        const logger = createSpyLogger();
        await login(logger, {}, name);
        expect(serverIdWarnings(logger), 'the throwing logger did not use it up').to.have.length(1);
    });

    it('does not fail the login for an api object whose fields cannot be read', async function () {
        const logger = createSpyLogger();
        const api = loginApi();
        Object.defineProperty(api, '__config', { get() { throw new Error('trap'); } });

        const token = await iamAuth(logger, {}, mount(), api)._authenticate();
        expect(token.getId()).to.equal('t');
    });

    it('keeps the "role" check first: a missing role still throws, without the warning', function () {
        const logger = createSpyLogger();
        expect(() => new VaultIAMAuth(loginApi(), logger, {}, mount()))
            .to.throw('"role" should be provided for VaultIAMAuth');
        expect(logger.warn).not.to.have.been.called;
    });

    it('sends the same login request as with the value set, minus only the header', async function () {
        // Sign both at one fixed time so the requests can be compared field for field.
        const clock = sinon.useFakeTimers({ now: Date.UTC(2026, 10, 6, 12, 0, 0), toFake: ['Date'] });
        try {
            const name = mount();
            const without = loginApi();
            const withHeader = loginApi();
            await iamAuth(createNoopLogger(), {}, name, without)._authenticate();
            await iamAuth(createNoopLogger(), { iam_server_id_header_value: 'v' }, name, withHeader)._authenticate();

            const [method, path, body] = without.makeRequest.firstCall.args;
            const [, pathWith, bodyWith] = withHeader.makeRequest.firstCall.args;
            expect(method).to.equal('POST');
            expect(path).to.equal(`/auth/${name}/login`).and.to.equal(pathWith);

            const decode = (b64) => Buffer.from(b64, 'base64').toString();
            for (const key of ['role', 'iam_http_request_method']) {
                expect(body[key]).to.equal(bodyWith[key]);
            }
            for (const key of ['iam_request_url', 'iam_request_body']) {
                expect(decode(body[key])).to.equal(decode(bodyWith[key]));
            }
            expect(decode(body.iam_request_url)).to.equal('https://sts.amazonaws.com/');

            const names = (b64) => Object.keys(JSON.parse(decode(b64))).map((k) => k.toLowerCase()).sort();
            expect(names(body.iam_request_headers)).to.deep.equal(
                names(bodyWith.iam_request_headers).filter((k) => k !== 'x-vault-aws-iam-server-id'));
            expect(names(body.iam_request_headers)).not.to.include('x-vault-aws-iam-server-id');
        } finally {
            clock.restore();
        }
    });

    describe('through VaultClient', function () {
        const iamClient = (name, logger) => {
            const client = new VaultClient({
                api: { url: 'https://vault.example.com:8200' },
                logger,
                auth: { type: 'iam', mount: name, config: { role: 'r', credentials: CREDENTIALS } },
            });
            sinon.stub(client.__auth.__apiClient, 'makeRequest').callsFake(answerLogin);
            return client;
        };

        it('is silent with logger: false, and does not use up the warning for other clients', async function () {
            const warn = sinon.stub(console, 'warn');
            const name = mount();
            const silent = iamClient(name, false);
            await silent.__auth.getAuthToken();
            silent.close();
            expect(warn).not.to.have.been.called;

            const logger = createSpyLogger();
            const client = iamClient(name, logger);
            await client.__auth.getAuthToken();
            client.close();
            expect(serverIdWarnings(logger)).to.have.length(1);
        });

        it('warns once per process with the default logger, however many clients there are', async function () {
            const warn = sinon.stub(console, 'warn');
            sinon.stub(console, 'info');
            const name = mount();
            for (let i = 0; i < 3; i++) {
                const client = iamClient(name, undefined);
                await client.__auth.getAuthToken();
                client.close();
            }
            expect(warn.getCalls().filter((c) => c.args[0] === WARNING)).to.have.length(1);
        });

        it('does not warn for a client whose construction fails after the backend was built', function () {
            const logger = createSpyLogger();
            expect(() => new VaultClient({
                api: { url: 'https://vault.example.com:8200' },
                logger,
                auth: { type: 'iam', mount: mount(), renewal: 'false', config: { role: 'r', credentials: CREDENTIALS } },
            })).to.throw();
            expect(logger.warn).not.to.have.been.called;
        });

        it('warns on the first login with the configured mount, also with a legacy auth.config.namespace', async function () {
            const logger = createSpyLogger();
            const name = mount();
            const client = new VaultClient({
                api: { url: 'https://vault.example.com:8200' },
                logger,
                auth: { type: 'iam', mount: name, config: { role: 'r', namespace: 'legacy-ns', credentials: CREDENTIALS } },
            });
            expect(logger.warn).not.to.have.been.called;
            sinon.stub(client.__auth.__apiClient, 'makeRequest').callsFake(answerLogin);

            await client.__auth.getAuthToken();

            expect(client.__auth.__apiClient.__namespace).to.equal('legacy-ns');
            expect(serverIdWarnings(logger).map((c) => c.args[1])).to.deep.equal([name]);
            client.close();
        });
    });
});
