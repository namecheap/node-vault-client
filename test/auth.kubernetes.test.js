'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const _ = require('lodash');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const VaultApiClient = require('../src/VaultApiClient');
const VaultKubernetesAuth = require('../src/auth/VaultKubernetesAuth');

const logger = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], function (prop) { return [prop, _.noop]; }));

describe('Kubernetes auth backend', function () {
    function getApiStub() {
        return sinon.createStubInstance(VaultApiClient);
    }

    const jwt = 'header.payload.signature';
    let tokenFile;

    beforeEach(function () {
        tokenFile = path.join(os.tmpdir(), 'k8s-jwt-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
        fs.writeFileSync(tokenFile, jwt);
    });

    afterEach(function () {
        try { fs.unlinkSync(tokenFile); } catch (e) { /* ignore */ }
    });

    it('logs in against the default "kubernetes" mount with role + jwt from the token file', async function () {
        const api = getApiStub();
        const auth = new VaultKubernetesAuth(api, logger, { role: 'my-role', tokenPath: tokenFile });
        api.makeRequest.withArgs('POST').resolves({ auth: { client_token: 'fake_token' } });
        sinon.stub(auth, '_getTokenEntity');

        await auth._authenticate();

        expect(api.makeRequest.calledWith(
            'POST',
            '/auth/kubernetes/login',
            { role: 'my-role', jwt: jwt }
        )).to.be.true;
        expect(auth._getTokenEntity.calledWith('fake_token')).to.be.true;
    });

    it('uses a custom mount point when provided', async function () {
        const api = getApiStub();
        const auth = new VaultKubernetesAuth(api, logger, { role: 'my-role', tokenPath: tokenFile }, 'k8s-custom');
        api.makeRequest.withArgs('POST').resolves({ auth: { client_token: 'fake_token' } });
        sinon.stub(auth, '_getTokenEntity');

        await auth._authenticate();

        expect(api.makeRequest.calledWith(
            'POST',
            '/auth/k8s-custom/login',
            { role: 'my-role', jwt: jwt }
        )).to.be.true;
    });

    it('reads the JWT from a custom tokenPath', async function () {
        const api = getApiStub();
        const customPath = path.join(os.tmpdir(), 'k8s-jwt-custom-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
        fs.writeFileSync(customPath, 'custom-jwt-value');
        const auth = new VaultKubernetesAuth(api, logger, { role: 'r', tokenPath: customPath });
        api.makeRequest.withArgs('POST').resolves({ auth: { client_token: 'fake_token' } });
        sinon.stub(auth, '_getTokenEntity');

        await auth._authenticate();

        const body = api.makeRequest.getCall(0).args[2];
        expect(body.jwt).to.equal('custom-jwt-value');
        fs.unlinkSync(customPath);
    });

    it('propagates an error when the token file is missing', function () {
        const api = getApiStub();
        const auth = new VaultKubernetesAuth(api, logger, { role: 'r', tokenPath: '/no/such/path/token-' + Date.now() });
        sinon.stub(auth, '_getTokenEntity');

        expect(function () { auth._authenticate(); }).to.throw();
    });
});
