'use strict';

const VaultBaseAuth = require('./VaultBaseAuth');
const aws4 = require('aws4');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const _ = require('lodash');
const errors = require('../errors');

/**
 * Implementation of AWS Auth Backend :: IAM Authentication Method
 * @link https://www.vaultproject.io/docs/auth/aws.html#iam-authentication-method
 *
 * @usage
 *
 * ```bash
 * vault write auth/aws/config/client secret_key=AWS_SECRET_KEY access_key=AWS_ACCESS_KEY
 * vault write auth/aws/config/client iam_server_id_header_value=VAULT_ADDR
 * vault write auth/aws/role/iam_name_of_role auth_type=iam bound_iam_principal_arn=arn:aws:iam::.... max_ttl=500h
 * ```
 *
 * ```js
 *
 * VaultClient.boot('main', {
 *       api: { url: VAULT_ADDR },
 *       auth: {
 *           type: 'iam',
 *           mount: 'some_other_aws_mount_point',          // Optional
 *           config: {
 *               role: 'my_iam_role',
 *               iam_server_id_header_value: VAULT_ADDR,   // Optional
 *               namespace: 'some_namespace',              // Optional
 *               region: 'eu-central-1',                   // Optional. AWS STS region.
 *               credentials: {                            // Optional
 *                 accessKeyId: AWS_ACCESS_KEY,
 *                 secretAccessKey: AWS_SECRET_KEY,
 *               },
 *           }
 *       }
 *   })
 * ```
 *
 */
class VaultIAMAuth extends VaultBaseAuth {
    /**
     * @typedef AWSCredentials
     * @property {String} accessKeyId
     * @property {String} secretAccessKey
     *
     * @typedef {Object} VaultIAMAuthConfig
     * @property {String} role - Role name of the auth/{mount}/role/{name} backend.
     * @property [AWSCredentials] [credentials] - Optional. AWS Credentials
     * @property {String} [iam_server_id_header_value] - Optional. Header's value X-Vault-AWS-IAM-Server-ID.
     * @property {String} [region] - Optional. AWS region used to sign the STS GetCallerIdentity
     *   request. When set, the request is signed against the regional STS endpoint
     *   (`sts.<region>.amazonaws.com`) and the SigV4 credential scope is bound to that region.
     *   When omitted, the global endpoint (`sts.amazonaws.com`, scope `us-east-1`) is used,
     *   preserving the previous default behavior.
     *
     * @param {VaultApiClient} api - see {@link VaultBaseAuth#constructor}
     * @param {Object} logger
     * @param {VaultIAMAuthConfig} config
     * @param {String} mount - Vault's AWS Auth Backend mount point ("aws" by default)
     */
    constructor(api, logger, config, mount) {
        super(api, logger, mount || 'aws');

        this.__role = config.role;
        this.__iam_server_id_header_value = config.iam_server_id_header_value;
        this.__namespace = config.namespace;
        this.__region = config.region;


        const { credentials } = config;
        this._validateCredentialsConfig(credentials);

        this.__credentialChain = credentials ? () => Promise.resolve(credentials) : fromNodeProviderChain();
    }

    /**
     * @inheritDoc
     */
    _authenticate() {
        this._log.info(
            'making authentication request: role=%s',
            this.__role
        );

        var headers = {};

        if (this.__namespace) {
            headers = {
                'X-Vault-Namespace': this.__namespace,
            }
        }


        return Promise.resolve()
            .then(() => this.__getCredentials())
            .then((credentials) => {
                return this.__apiClient.makeRequest(
                    'POST',
                    `/auth/${this._mount}/login`,
                    this.__getVaultAuthRequestBody(this.__getStsRequest(credentials)),
                    headers
                );
            })
            .then((response) => {
                this._log.debug(
                    'receive token: %s',
                    response.auth.client_token
                );
                return this._getTokenEntity(response.auth.client_token)
            })
    }

    /**
     * Credentials resolved by {@see @aws-sdk/credential-providers}
     *
     * @returns {Promise<AwsCredentialIdentity>}
     * @private
     */
    __getCredentials() {
        return this.__credentialChain();
    }

    /**
     * Prepare vault auth request body
     *
     * @param stsRequest
     * @returns {Object} {@link https://www.vaultproject.io/docs/auth/aws.html#via-the-api}
     * @private
     */
    __getVaultAuthRequestBody(stsRequest) {
        return {
            iam_http_request_method: stsRequest.method,
            iam_request_headers: this.__base64encode(
                JSON.stringify(this.__headersLikeGolangStyle(stsRequest.headers))
            ),
            iam_request_body: this.__base64encode(stsRequest.body),
            // `aws4` populates `hostname` for the default (global) endpoint, but
            // `host` when an explicit host is supplied (regional endpoint). Use
            // whichever is present so the URL sent to Vault matches the signed
            // Host header.
            iam_request_url: this.__base64encode(`https://${stsRequest.host || stsRequest.hostname}${stsRequest.path}`),
            role: this.__role
        }
    }

    /**
     * Prepare signed request to AWS STS :: GetCallerIdentity
     *
     * @param credentials
     * @private
     */
    __getStsRequest(credentials) {
        const request = {
            service: 'sts',
            method: 'POST',
            body: 'Action=GetCallerIdentity&Version=2011-06-15',
            headers: this.__iam_server_id_header_value ? {
                'X-Vault-AWS-IAM-Server-ID': this.__iam_server_id_header_value,
            } : {}
        };

        // When a region is configured, sign the request against the regional STS
        // endpoint. Both the SigV4 credential scope (via `region`) and the signed
        // Host header / request URL (via `host`) must reference the same region,
        // otherwise Vault's STS replay fails with `SignatureDoesNotMatch`.
        // When omitted, `aws4` defaults to the global endpoint (`sts.amazonaws.com`,
        // scope `us-east-1`), preserving the previous behavior.
        if (this.__region) {
            request.region = this.__region;
            request.host = `sts.${this.__region}.amazonaws.com`;
        }

        return aws4.sign(request, credentials);
    }

    /**
     * @param string
     * @private
     */
    __base64encode(string) {
        return Buffer.from(string).toString('base64')
    }

    /**
     * @link https://github.com/hashicorp/vault/issues/2810
     * @link https://golang.org/pkg/net/http/#Header
     *
     * @param {Object} headers
     * @returns {Object}
     * @private
     */
    __headersLikeGolangStyle(headers) {
        return _.mapValues(headers, (value) => [`${value}`]);
    }

    _validateCredentialsConfig(credentials) {
        if (Array.isArray(credentials)) {
            throw new errors.InvalidAWSCredentialsError('Invalid AWS credentials provided in config. See CHANGELOG if migating from 0.x.x');
        }
        if (credentials && typeof credentials === 'object') {
            if (!credentials.secretAccessKey || !credentials.accessKeyId) {
                throw new errors.InvalidAWSCredentialsError('Invalid AWS credentials provided in config: accessKeyId and secretAccessKey are required.');
            }
        }
    }
}

module.exports = VaultIAMAuth;
