'use strict';

const _ = require('lodash');
const VaultClient = require('../src/VaultClient');
const VaultApiClient = require('../src/VaultApiClient');
const VaultIAMAuth = require('../src/auth/VaultIAMAuth');
const errors = require('../src/errors');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const AWS = require('aws-sdk');
chai.use(require('sinon-chai'));

const logger = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (prop) => [prop, _.noop]));

describe('Unit AWS auth backend :: IAM', function () {

    function base64decode(str) {
        return new Buffer(str, 'base64').toString();
    }

    function getAuthorizationHeaderRegExp(awsAccessKey) {
        return new RegExp(`^AWS4-HMAC-SHA256\\sCredential=${awsAccessKey}.+Signature=\\w+$`)
    }

    /**
     * @returns {VaultApiClient}
     */
    function getApiStub() {
        return sinon.createStubInstance(VaultApiClient);
    }

    describe('Vault Request', function () {
        it('Should make correctly vault login request', async function () {
            const api = getApiStub();

            const auth = new VaultIAMAuth(
                api,
                logger,
                {
                    role: 'MyRole',
                    iam_server_id_header_value: 'https://vault.fake.com',
                    credentials: new AWS.Credentials('FAKE_AWS_ACCESS_KEY', 'FAKE_AWS_SECRET_KEY')
                },
                'fake_aws'
            );

            api.makeRequest.withArgs('POST').resolves({auth: {client_token: 'fake_token'}});
            sinon.stub(auth, '_getTokenEntity');

            await auth._authenticate();

            const args = api.makeRequest.getCall(0).args;
            expect(args[0]).to.equal('POST');
            expect(args[1]).to.equal('/auth/fake_aws/login');
            expect(args[2].iam_http_request_method).to.equal('POST');
            expect(args[2].role).to.equal('MyRole');
            expect(base64decode(args[2].iam_request_body)).to.equal('Action=GetCallerIdentity&Version=2011-06-15');
            expect(base64decode(args[2].iam_request_url)).to.equal('https://sts.amazonaws.com/');
            const headers = JSON.parse(base64decode(args[2].iam_request_headers));
            expect(headers['X-Vault-AWS-IAM-Server-ID']).to.deep.equal(['https://vault.fake.com']);
            expect(headers['Authorization'][0]).to.match(getAuthorizationHeaderRegExp('FAKE_AWS_ACCESS_KEY'));
        });
    });

    describe('Credentials', function () {
        function instantiate(credentials) {
            const api = getApiStub();
            const auth = new VaultIAMAuth(
                api,
                logger,
                {
                    role: 'MyRole',
                    iam_server_id_header_value: 'https://vault.fake.com',
                    credentials: credentials
                },
                'fake_aws'
            );

            sinon.stub(auth, '_getTokenEntity');
            api.makeRequest.withArgs('POST').resolves({auth: {client_token: 'fake_token'}})

            return {api, auth};
        }

        it('Should work correctly with {AWS.Credentials}', async function () {
            const instance = instantiate(new AWS.Credentials('FAKE_AWS_ACCESS_KEY', 'FAKE_AWS_SECRET_KEY'));

            await instance.auth._authenticate();

            const args = instance.api.makeRequest.getCall(0).args;
            const headers = JSON.parse(base64decode(args[2].iam_request_headers));

            expect(headers['Authorization'][0]).to.match(getAuthorizationHeaderRegExp('FAKE_AWS_ACCESS_KEY'));
        });

        it('Should work correctly with {AWS.Credentials[]}', async function () {
            const instance = instantiate([
                new AWS.Credentials('FAKE_AWS_ACCESS_KEY2', 'FAKE_AWS_SECRET_KEY2'),
                new AWS.Credentials('FAKE_AWS_ACCESS_KEY', 'FAKE_AWS_SECRET_KEY'),
            ]);

            await instance.auth._authenticate();

            const args = instance.api.makeRequest.getCall(0).args;
            const headers = JSON.parse(base64decode(args[2].iam_request_headers));

            expect(headers['Authorization'][0]).to.match(getAuthorizationHeaderRegExp('FAKE_AWS_ACCESS_KEY2'));
        });

        it('Should work correctly with AWS.Credentials Provider ({() => AWS.Credentials})', async function () {
            const instance = instantiate(
                [() => new AWS.Credentials('FAKE_AWS_ACCESS_KEY2', 'FAKE_AWS_SECRET_KEY2')]
            );

            await instance.auth._authenticate();

            const args = instance.api.makeRequest.getCall(0).args;
            const headers = JSON.parse(base64decode(args[2].iam_request_headers));

            expect(headers['Authorization'][0]).to.match(getAuthorizationHeaderRegExp('FAKE_AWS_ACCESS_KEY2'));
        });

        it('Should throw InvalidAWSCredentialsError without credentials', async function () {
            expect(() => instantiate(null)).to.throw(errors.InvalidAWSCredentialsError);
            expect(() => instantiate(undefined)).to.throw(errors.InvalidAWSCredentialsError);
        });
    });
});
