import fs from 'fs';
import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultKubernetesAuth from '../src/auth/VaultKubernetesAuth.js';
import AuthToken from '../src/auth/AuthToken.js';

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
