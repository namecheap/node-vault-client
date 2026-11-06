'use strict';

const VaultBaseAuth = require('./VaultBaseAuth');
const aws4 = require('aws4');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const errors = require('../errors');
const warnOnce = require('../warnOnce');

/**
 * The Vault server part of the warning key: origin and path of `api.url`, so spellings such as a
 * trailing slash or an upper-case host name the same server. An unparsable value is used as is.
 * @param {*} url
 * @returns {string}
 * @private
 */
function serverKey(url) {
    try {
        const parsed = new URL(url);
        return parsed.origin + parsed.pathname.replace(/\/+$/, '');
    } catch {
        return String(url);
    }
}

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
     * @property {AWSCredentials} [credentials] - Optional. AWS Credentials
     * @property {String} [namespace] - Optional. Vault namespace. Applied as the X-Vault-Namespace
     *   header to every request by {@link VaultApiClient}; see {@link VaultClient#constructor}.
     * @property {String} [iam_server_id_header_value] - Optional. Header's value X-Vault-AWS-IAM-Server-ID.
     *   Without it the signed request names no Vault server, and the first login logs a warning,
     *   once per Vault server, namespace and mount in a process.
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

        if (!config || !config.role) {
            throw new errors.InvalidArgumentsError('"role" should be provided for VaultIAMAuth');
        }

        this.__role = config.role;
        this.__iam_server_id_header_value = config.iam_server_id_header_value;
        this.__region = config.region;


        const { credentials } = config;
        this._validateCredentialsConfig(credentials);

        this.__credentialChain = credentials ? () => Promise.resolve(credentials) : fromNodeProviderChain();
    }

    /**
     * Without `X-Vault-AWS-IAM-Server-ID` the signed STS request names no Vault server, so a
     * server that receives it (or anyone who captures it) can replay it to another Vault server
     * that trusts the same AWS principal until the signature expires. Warn once per Vault server,
     * namespace and mount for each logger (once per process on the default logger) when the
     * header will not be sent or holds only whitespace. Called on login, not in the constructor,
     * so a client whose construction fails later (in VaultClient) logs nothing. Never throws: a
     * failure here must not fail the login.
     * @returns {void}
     * @private
     */
    __warnOnMissingServerId() {
        try {
            const value = this.__iam_server_id_header_value;
            // A value of only whitespace is sent, but names no server either.
            if (typeof value === 'string' ? value.trim() !== '' : value) {
                return;
            }
            const api = this.__apiClient || {};
            const key = [serverKey(api.__config && api.__config.url), String(api.__namespace), this._mount]
                .join('\u0000');
            warnOnce(
                this._log,
                key,
                'IAM login on mount "%s" is not configured with "iam_server_id_header_value", so the signed '
                + 'STS request names no Vault server and could be replayed to another one that trusts the same '
                + 'AWS principal. Set it to the same value as iam_server_id_header_value on auth/%s/config/client',
                this._mount, this._mount
            );
        } catch {
            // an odd api object changes nothing here
        }
    }

    /**
     * @inheritDoc
     */
    _authenticate() {
        this.__warnOnMissingServerId();
        this._log.info(
            'making authentication request: role=%s',
            this.__role
        );

        return Promise.resolve()
            .then(() => this.__getCredentials())
            .then((credentials) => {
                return this.__apiClient.makeRequest(
                    'POST',
                    `/auth/${this._mount}/login`,
                    this.__getVaultAuthRequestBody(this.__getStsRequest(credentials))
                );
            })
            .then((response) => {
                this._log.debug(
                    'received token (accessor=%s)',
                    response.auth.accessor
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
        return Object.fromEntries(
            Object.entries(headers).map(([key, value]) => [key, [`${value}`]])
        );
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
