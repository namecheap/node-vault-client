import fs from 'fs';
import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultKubernetesAuth from '../src/auth/VaultKubernetesAuth.js';
import VaultClient from '../src/VaultClient.js';
import AuthToken from '../src/auth/AuthToken.js';
import errors from '../src/errors.js';

use(sinonChai);

const logger = { error: _.noop, warn: _.noop, info: _.noop, debug: _.noop, trace: _.noop };

function apiStub() {
    return sinon.createStubInstance(VaultApiClient);
}

describe('VaultKubernetesAuth', function () {
    let readFileSync;

    afterEach(function () {
        readFileSync?.restore();
    });

    it('defaults the mount and reads the kube token from the default path', function () {
        readFileSync = sinon.stub(fs, 'readFileSync').returns(Buffer.from('jwt-token'));
        const api = apiStub();
        api.makeRequest.resolves({ auth: { client_token: 'vault-token' } });
        const auth = new VaultKubernetesAuth(api, logger, { role: 'r' });
        sinon.stub(auth, '_getTokenEntity').resolves(new AuthToken('id', 'acc', 0, null, 0, 0, false));

        expect(auth._mount).to.equal('kubernetes');
        return auth._authenticate().then(() => {
            expect(readFileSync).to.have.been.calledWith('/var/run/secrets/kubernetes.io/serviceaccount/token');
        });
    });

    it('honours a custom mount and reads the kube token from a custom path', function () {
        readFileSync = sinon.stub(fs, 'readFileSync').returns(Buffer.from('jwt-token'));
        const api = apiStub();
        api.makeRequest.resolves({ auth: { client_token: 'vault-token' } });
        const auth = new VaultKubernetesAuth(api, logger, { role: 'r', tokenPath: '/tmp/tok' }, 'k8s');
        sinon.stub(auth, '_getTokenEntity').resolves(new AuthToken('id', 'acc', 0, null, 0, 0, false));

        expect(auth._mount).to.equal('k8s');
        return auth._authenticate().then(() => {
            expect(readFileSync).to.have.been.calledWith('/tmp/tok');
        });
    });

    it('reads the JWT from disk and performs a login request', function () {
        readFileSync = sinon.stub(fs, 'readFileSync').returns(Buffer.from('jwt-token'));
        const api = apiStub();
        api.makeRequest.resolves({ auth: { client_token: 'vault-token' } });
        const auth = new VaultKubernetesAuth(api, logger, { role: 'my-role', tokenPath: '/tmp/tok' }, 'k8s');
        const entity = new AuthToken('id', 'acc', 0, null, 0, 0, false);
        sinon.stub(auth, '_getTokenEntity').resolves(entity);

        return auth._authenticate().then((token) => {
            expect(readFileSync).to.have.been.calledWith('/tmp/tok');
            expect(api.makeRequest).to.have.been.calledWith('POST', '/auth/k8s/login', { role: 'my-role', jwt: 'jwt-token' });
            expect(auth._getTokenEntity).to.have.been.calledWith('vault-token');
            expect(token).to.equal(entity);
        });
    });

    it('throws InvalidArgumentsError when the role is missing', function () {
        expect(() => new VaultKubernetesAuth(apiStub(), logger, {}))
            .to.throw(errors.InvalidArgumentsError, '"role" should be provided for VaultKubernetesAuth');
        expect(() => new VaultKubernetesAuth(apiStub(), logger, undefined))
            .to.throw(errors.InvalidArgumentsError, '"role" should be provided for VaultKubernetesAuth');
    });

    it('rejects with the fs error when the service-account token file is missing or unreadable, without hitting Vault', async function () {
        const fsError = new Error("ENOENT: no such file or directory, open '/var/run/secrets/kubernetes.io/serviceaccount/token'");
        fsError.code = 'ENOENT';
        readFileSync = sinon.stub(fs, 'readFileSync').throws(fsError);
        const api = apiStub();
        const auth = new VaultKubernetesAuth(api, logger, { role: 'r' });

        let thrownSynchronously = false;
        let rejection;
        try {
            await auth._authenticate().catch((err) => { rejection = err; });
        } catch (err) {
            thrownSynchronously = true;
            rejection = err;
        }

        expect(thrownSynchronously, '_authenticate() must not throw before returning a promise').to.equal(false);
        expect(rejection).to.equal(fsError);
        expect(api.makeRequest).to.not.have.been.called;
    });

    it('surfaces the fs error to a .catch() on client.read()', async function () {
        const fsError = new Error('EACCES: permission denied');
        fsError.code = 'EACCES';
        readFileSync = sinon.stub(fs, 'readFileSync').throws(fsError);

        const client = new VaultClient({
            api: { url: 'https://vault.example/' },
            logger: false,
            auth: { type: 'kubernetes', config: { role: 'r' } },
        });

        let handled;
        await new Promise((done) => {
            client.read('secret/x').catch((err) => { handled = err; done(); });
        });

        expect(handled, 'the handler attached to read() must receive it').to.equal(fsError);
        VaultClient.clear();
    });

    it('never logs the JWT or the Vault client token', function () {
        readFileSync = sinon.stub(fs, 'readFileSync').returns(Buffer.from('super-secret-jwt'));
        const debug = sinon.spy();
        const api = apiStub();
        api.makeRequest.resolves({ auth: { client_token: 'super-secret-vault-token' } });
        const auth = new VaultKubernetesAuth(api, _.assign({}, logger, { debug }), { role: 'r', tokenPath: '/tmp/tok' }, 'k8s');
        sinon.stub(auth, '_getTokenEntity').resolves(new AuthToken('id', 'acc', 0, null, 0, 0, false));

        return auth._authenticate().then(() => {
            const leaked = debug.getCalls().some((call) =>
                call.args.some((arg) => typeof arg === 'string'
                    && (arg.includes('super-secret-jwt') || arg.includes('super-secret-vault-token'))));
            expect(leaked, 'JWT and client token must not be logged').to.equal(false);
        });
    });
});
