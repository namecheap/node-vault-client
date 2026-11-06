/**
 * A warning when an IAM login is configured without `iam_server_id_header_value` (part of
 * #202): the signed STS request then names no Vault server and could be replayed to another
 * one that trusts the same AWS principal. Logged once per mount per process; nothing else
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

// The warning is deduplicated per mount for the whole process, so every test gets mounts of its own.
let seq = 0;
const mount = () => `aws-${process.pid}-${Date.now().toString(36)}-${++seq}`;

function serverIdWarnings(logger) {
    return logger.warn.getCalls().filter((c) => c.args[0] === WARNING);
}

function iamAuth(logger, config, mountName) {
    return new VaultIAMAuth(sinon.createStubInstance(VaultApiClient), logger,
        Object.assign({ role: 'r', credentials: CREDENTIALS }, config), mountName);
}

describe('IAM iam_server_id_header_value warning', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('warns, naming the mount, when the value is not configured', function () {
        const logger = createSpyLogger();
        const name = mount();
        iamAuth(logger, {}, name);

        expect(serverIdWarnings(logger).map((c) => c.args)).to.deep.equal([[WARNING, name, name]]);
    });

    it('warns for an empty value, which sends no header either', function () {
        const logger = createSpyLogger();
        const name = mount();
        iamAuth(logger, { iam_server_id_header_value: '' }, name);

        expect(serverIdWarnings(logger)).to.have.length(1);
    });

    it('does not warn when the value is configured', function () {
        const logger = createSpyLogger();
        iamAuth(logger, { iam_server_id_header_value: 'vault.example.com' }, mount());

        expect(logger.warn).not.to.have.been.called;
    });

    it('logs once per mount for the whole process, however many backends use it', function () {
        const first = createSpyLogger();
        const second = createSpyLogger();
        const name = mount();
        iamAuth(first, {}, name);
        iamAuth(first, {}, name);
        iamAuth(second, {}, name);

        expect(serverIdWarnings(first)).to.have.length(1);
        expect(serverIdWarnings(second), 'already warned in this process').to.have.length(0);
    });

    it('warns again for another mount', function () {
        const logger = createSpyLogger();
        const a = mount();
        const b = mount();
        iamAuth(logger, {}, a);
        iamAuth(logger, {}, b);

        expect(serverIdWarnings(logger).map((c) => c.args[1])).to.deep.equal([a, b]);
    });

    it('sends a truthy non-string value as before, without a warning', function () {
        const logger = createSpyLogger();
        iamAuth(logger, { iam_server_id_header_value: 42 }, mount());
        expect(logger.warn).not.to.have.been.called;
    });

    it('logs nothing, and uses up no warning, when the constructor rejects the credentials', function () {
        const logger = createSpyLogger();
        const name = mount();
        expect(() => iamAuth(logger, { credentials: { accessKeyId: 'AKIDEXAMPLE' } }, name)).to.throw();
        expect(logger.warn).not.to.have.been.called;

        iamAuth(logger, {}, name);
        expect(serverIdWarnings(logger), 'the corrected client still warns').to.have.length(1);
    });

    it('warns separately for the same mount under another namespace or Vault server', function () {
        const logger = createSpyLogger();
        const name = mount();
        const make = (url, namespace) => new VaultIAMAuth(new VaultApiClient({ url }, createNoopLogger(), namespace),
            logger, { role: 'r', credentials: CREDENTIALS }, name);
        make('https://a.example:8200', 'ns1');
        make('https://a.example:8200', 'ns1');
        make('https://a.example:8200', 'ns2');
        make('https://b.example:8200', 'ns1');
        make('https://a.example:8200', undefined);

        expect(serverIdWarnings(logger)).to.have.length(4);
    });

    it('does not let a throwing logger fail construction', function () {
        const logger = createNoopLogger();
        logger.warn = () => {
            throw new Error('logger down');
        };
        expect(() => iamAuth(logger, {}, mount())).not.to.throw();
    });

    it('keeps the "role" check first: a missing role still throws, without the warning', function () {
        const logger = createSpyLogger();
        expect(() => new VaultIAMAuth(sinon.createStubInstance(VaultApiClient), logger, {}, mount()))
            .to.throw('"role" should be provided for VaultIAMAuth');
        expect(logger.warn).not.to.have.been.called;
    });

    it('sends the same login request as before, still without the header', async function () {
        const logger = createSpyLogger();
        const api = sinon.createStubInstance(VaultApiClient);
        api.makeRequest.onFirstCall().resolves({ auth: { client_token: 't', accessor: 'a' } });
        api.makeRequest.onSecondCall().resolves({ data: { id: 't', accessor: 'a', ttl: 60, renewable: false } });
        const name = mount();
        const auth = new VaultIAMAuth(api, logger, { role: 'r', credentials: CREDENTIALS }, name);

        await auth._authenticate();

        const [method, path, body] = api.makeRequest.firstCall.args;
        expect(method).to.equal('POST');
        expect(path).to.equal(`/auth/${name}/login`);
        const decode = (b64) => Buffer.from(b64, 'base64').toString();
        expect(Object.keys(body).sort()).to.deep.equal([
            'iam_http_request_method', 'iam_request_body', 'iam_request_headers', 'iam_request_url', 'role',
        ]);
        expect(body.role).to.equal('r');
        expect(body.iam_http_request_method).to.equal('POST');
        expect(decode(body.iam_request_url)).to.equal('https://sts.amazonaws.com/');
        expect(decode(body.iam_request_body)).to.equal('Action=GetCallerIdentity&Version=2011-06-15');
        const headers = JSON.parse(decode(body.iam_request_headers));
        expect(Object.keys(headers).map((h) => h.toLowerCase())).not.to.include('x-vault-aws-iam-server-id');
    });

    describe('through VaultClient', function () {
        it('goes to the configured logger with the configured mount', function () {
            const logger = createSpyLogger();
            const name = mount();
            new VaultClient({
                api: { url: 'https://vault.example.com:8200' },
                logger,
                auth: { type: 'iam', mount: name, config: { role: 'r', credentials: CREDENTIALS } },
            });
            expect(serverIdWarnings(logger).map((c) => c.args[1])).to.deep.equal([name]);
        });

        it('is silent with logger: false', function () {
            const warn = sinon.stub(console, 'warn');
            new VaultClient({
                api: { url: 'https://vault.example.com:8200' },
                logger: false,
                auth: { type: 'iam', mount: mount(), config: { role: 'r', credentials: CREDENTIALS } },
            });
            expect(warn).not.to.have.been.called;
        });
    });
});
