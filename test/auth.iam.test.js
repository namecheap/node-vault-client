'use strict';

require('co-mocha');

const VaultClient = require('../src/VaultClient');
const VaultApiClient = require('../src/VaultApiClient');
const VaultIAMAuth = require('../src/auth/VaultIAMAuth');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const AWS = require('aws-sdk');

chai.use(require('sinon-chai'));

describe('Unit AWS auth backend :: IAM', function () {


    /**
     * @returns {VaultApiClient}
     */
    function getApiStub() {
        return sinon.createStubInstance(VaultApiClient);
    }

    it('Should _authenticate calls make correct vault request', function* () {
        const api = getApiStub();

        const auth = new VaultIAMAuth(
            api,
            false,
            {
                role: 'MyRole',
                iam_server_id_header_value: 'https://vault.fake.com'
            },
            'fake_aws'
        );

        api.makeRequest.withArgs('POST').resolves({auth: {client_token: 'fake_token'}});
        sinon.stub(auth, '_getTokenEntity');

        yield auth._authenticate();

        const args = api.makeRequest.getCall(0).args;
        expect(args[0]).to.equal('POST');
        expect(args[1]).to.equal('/auth/fake_aws/login');
        expect(args[2].iam_http_request_method).to.equal('POST');
        expect(args[2].role).to.equal('MyRole');
        expect(args[2].iam_request_body).to.be.a('string');
        expect(args[2].iam_request_headers).to.be.a('string');
        expect(args[2].iam_request_url).to.be.a('string');

        const headers = JSON.parse(new Buffer(args[2].iam_request_headers, 'base64').toString());
        expect(headers['X-Vault-AWS-IAM-Server-ID']).to.deep.equal(['https://vault.fake.com']);
    });

    it('Should use passed credentials', function* () {
        const credentials = new AWS.Credentials('FAKE_AWS_SUCCESS_KEY', 'FAKE_AWS_SECRET_KEY');
        const auth = new VaultIAMAuth(
            getApiStub(),
            false,
            {
                role: 'MyRole',
                credentials: credentials
            },
            'fake_aws'
        );

        expect(yield auth.__getCredentials()).to.equal(credentials)
    });
});