import fs from 'fs';
import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultKubernetesAuth from '../src/auth/VaultKubernetesAuth.js';
import AuthToken from '../src/auth/AuthToken.js';

use(sinonChai);

const logger = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (p) => [p, _.noop]));

function apiStub() {
    return sinon.createStubInstance(VaultApiClient);
}

describe('VaultKubernetesAuth', function () {
    let readFileSync;

    afterEach(function () {
        if (readFileSync) {
            readFileSync.restore();
            readFileSync = null;
        }
    });

    it('defaults the mount and the kube token path', function () {
        const auth = new VaultKubernetesAuth(apiStub(), logger, { role: 'r' });
        expect(auth._mount).to.equal('kubernetes');
        expect(auth.__tokenPath).to.equal('/var/run/secrets/kubernetes.io/serviceaccount/token');
    });

    it('honours a custom mount and token path', function () {
        const auth = new VaultKubernetesAuth(apiStub(), logger, { role: 'r', tokenPath: '/tmp/tok' }, 'k8s');
        expect(auth._mount).to.equal('k8s');
        expect(auth.__tokenPath).to.equal('/tmp/tok');
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
});
