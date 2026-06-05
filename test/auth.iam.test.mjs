import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultIAMAuth from '../src/auth/VaultIAMAuth.js';
import errors from '../src/errors.js';

use(sinonChai);

const logger = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (prop) => [prop, _.noop]));

describe('Unit AWS auth backend :: IAM', function () {

    function base64decode(str) {
        return Buffer.from(str, 'base64').toString();
    }

    function getAuthorizationHeaderRegExp(awsAccessKey) {
        return new RegExp(`^AWS4-HMAC-SHA256\\sCredential=${awsAccessKey}.+Signature=\\w+$`);
    }

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
                    credentials: {
                        accessKeyId: 'FAKE_AWS_ACCESS_KEY',
                        secretAccessKey: 'FAKE_AWS_SECRET_KEY',
                    },
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

        describe('credentials from environment variables', () => {
            let originalAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
            let originalSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
            before(() => {
                process.env.AWS_ACCESS_KEY_ID = 'FAKE_AWS_ACCESS_KEY';
                process.env.AWS_SECRET_ACCESS_KEY = 'FAKE_AWS_SECRET_KEY';
            });

            after(() => {
                process.env.AWS_SECRET_ACCESS_KEY = originalSecretAccessKey;
                process.env.AWS_ACCESS_KEY_ID = originalAccessKeyId;
            });

            it('should take AWS credentials from environment variables when not passed explicitly', async function () {
                const api = getApiStub();

                const auth = new VaultIAMAuth(
                    api,
                    logger,
                    {
                        role: 'MyRole',
                        iam_server_id_header_value: 'https://vault.fake.com',
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

        it('Should target the regional STS endpoint and scope the signature to the region when `region` is set', async function () {
            const api = getApiStub();

            const auth = new VaultIAMAuth(
                api,
                logger,
                {
                    role: 'MyRole',
                    iam_server_id_header_value: 'https://vault.fake.com',
                    region: 'eu-central-1',
                    credentials: {
                        accessKeyId: 'FAKE_AWS_ACCESS_KEY',
                        secretAccessKey: 'FAKE_AWS_SECRET_KEY',
                    },
                },
                'fake_aws'
            );

            api.makeRequest.withArgs('POST').resolves({auth: {client_token: 'fake_token'}});
            sinon.stub(auth, '_getTokenEntity');

            await auth._authenticate();

            const args = api.makeRequest.getCall(0).args;

            // URL sent to Vault must point at the regional endpoint.
            expect(base64decode(args[2].iam_request_url)).to.equal('https://sts.eu-central-1.amazonaws.com/');

            const headers = JSON.parse(base64decode(args[2].iam_request_headers));

            // Signed Host header must match the URL (otherwise Vault's STS replay fails).
            expect(headers['Host']).to.deep.equal(['sts.eu-central-1.amazonaws.com']);

            // SigV4 credential scope must be bound to the configured region.
            expect(headers['Authorization'][0]).to.match(getAuthorizationHeaderRegExp('FAKE_AWS_ACCESS_KEY'));
            expect(headers['Authorization'][0]).to.contain('/eu-central-1/sts/aws4_request');
        });

        it('Should preserve the global STS endpoint and us-east-1 scope when `region` is omitted', async function () {
            const api = getApiStub();

            const auth = new VaultIAMAuth(
                api,
                logger,
                {
                    role: 'MyRole',
                    iam_server_id_header_value: 'https://vault.fake.com',
                    credentials: {
                        accessKeyId: 'FAKE_AWS_ACCESS_KEY',
                        secretAccessKey: 'FAKE_AWS_SECRET_KEY',
                    },
                },
                'fake_aws'
            );

            api.makeRequest.withArgs('POST').resolves({auth: {client_token: 'fake_token'}});
            sinon.stub(auth, '_getTokenEntity');

            await auth._authenticate();

            const args = api.makeRequest.getCall(0).args;

            expect(base64decode(args[2].iam_request_url)).to.equal('https://sts.amazonaws.com/');

            const headers = JSON.parse(base64decode(args[2].iam_request_headers));
            expect(headers['Authorization'][0]).to.match(getAuthorizationHeaderRegExp('FAKE_AWS_ACCESS_KEY'));
            expect(headers['Authorization'][0]).to.contain('/us-east-1/sts/aws4_request');
        });

        it('Should set the namespace header when configured', async function () {
            const api = getApiStub();

            const auth = new VaultIAMAuth(
                api,
                logger,
                {
                    role: 'MyRole',
                    namespace: 'ns1',
                    credentials: {
                        accessKeyId: 'FAKE_AWS_ACCESS_KEY',
                        secretAccessKey: 'FAKE_AWS_SECRET_KEY',
                    },
                },
                'fake_aws'
            );

            api.makeRequest.withArgs('POST').resolves({auth: {client_token: 'fake_token'}});
            sinon.stub(auth, '_getTokenEntity');

            await auth._authenticate();

            const args = api.makeRequest.getCall(0).args;
            expect(args[3]).to.deep.equal({'X-Vault-Namespace': 'ns1'});
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
            api.makeRequest.withArgs('POST').resolves({auth: {client_token: 'fake_token'}});

            return {api, auth};
        }

        it('Should work correctly with explicitly passed AWS credentials', async function () {
            const instance = instantiate({
                accessKeyId: 'FAKE_AWS_ACCESS_KEY',
                secretAccessKey: 'FAKE_AWS_SECRET_KEY',
            });

            await instance.auth._authenticate();

            const args = instance.api.makeRequest.getCall(0).args;
            const headers = JSON.parse(base64decode(args[2].iam_request_headers));

            expect(headers['Authorization'][0]).to.match(getAuthorizationHeaderRegExp('FAKE_AWS_ACCESS_KEY'));
        });

        it('Should throw InvalidAWSCredentialsError if secretAccessKey is missing', () => {
            expect(() => instantiate({
                accessKeyId: 'FAKE_AWS_ACCESS_KEY',
            })).to.throw(errors.InvalidAWSCredentialsError);
        });

        it('Should throw InvalidAWSCredentialsError if accessKeyId is missing', () => {
            expect(() => instantiate({
                secretAccessKey: 'FAKE_AWS_SECRET_KEY',
            })).to.throw(errors.InvalidAWSCredentialsError);
        });

        it('Should throw InvalidAWSCredentialsError if credentials are an array', () => {
            expect(() => instantiate([])).to.throw(errors.InvalidAWSCredentialsError);
        });
    });

    describe('base64 encoding', function () {
        it('encodes via Buffer.from (no deprecated new Buffer) and round-trips', function () {
            const auth = new VaultIAMAuth(getApiStub(), logger, { role: 'MyRole' }, 'aws');
            const input = 'Action=GetCallerIdentity&Version=2011-06-15';
            const encoded = auth.__base64encode(input);
            expect(encoded).to.equal(Buffer.from(input).toString('base64'));
            expect(base64decode(encoded)).to.equal(input);
        });
    });
});
