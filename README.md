# Node.js Vault Client

![npm](https://img.shields.io/npm/v/node-vault-client)
![npm](https://img.shields.io/npm/dm/node-vault-client)

A Vault Client implemented in pure javascript for [HashiCorp Vault](https://github.com/hashicorp/vault).
It supports variety of Auth Backends and performs lease renewal for issued auth token.

## Install
```
npm install --save node-vault-client
```

### Requirements

Node.js >= 18 — the client uses the native `fetch` API.

## Example

```javascript
const VaultClient = require('node-vault-client');

const vaultClient = VaultClient.boot('main', {
    api: { url: 'https://vault.example.com:8200/' },
    auth: { 
        type: 'appRole', // one of: 'appRole' | 'token' | 'iam' | 'kubernetes'
        config: { role_id: '637c065f-c644-5e12-d3d1-e9fa4363af61' } 
    },
});

vaultClient.read('secret/tst').then(lease => {
    console.log(lease.getData()); // read() resolves to a Lease; use getData()/getValue(key)
}).catch(e => console.error(e));
```

## Supported Auth Backends

* [AWS IAM](https://developer.hashicorp.com/vault/docs/auth/aws)
* [AppRole](https://developer.hashicorp.com/vault/docs/auth/approle)
* [Token](https://developer.hashicorp.com/vault/docs/auth/token)
* [Kubernetes](https://developer.hashicorp.com/vault/docs/auth/kubernetes)

### AWS IAM auth

```javascript
const vaultClient = VaultClient.boot('main', {
    api: { url: 'https://vault.example.com:8200/' },
    auth: {
        type: 'iam',
        mount: 'aws',                                  // Optional. Vault AWS auth mount point ("aws" by default)
        config: {
            role: 'my_iam_role',
            iam_server_id_header_value: 'https://vault.example.com:8200/', // Optional. X-Vault-AWS-IAM-Server-ID header
            namespace: 'some_namespace',               // Optional. X-Vault-Namespace header
            region: 'eu-central-1',                     // Optional. AWS STS region (see below)
            credentials: {                             // Optional. Resolved from the AWS provider chain when omitted
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        },
    },
});
```

#### `region`

By default the signed `GetCallerIdentity` request targets the global STS endpoint
`sts.amazonaws.com` and the SigV4 credential scope is bound to `us-east-1`. Set
`config.region` to sign against a regional STS endpoint instead — the request is then sent to
`sts.<region>.amazonaws.com` and the signature scope is bound to that region. This is required
when Vault's `sts_region` / `sts_endpoint` is configured for a non-`us-east-1` region (e.g.
`eu-central-1`); otherwise STS rejects the replayed request with
`SignatureDoesNotMatch — Credential should be scoped to a valid region`. Omitting `region`
preserves the previous (global-endpoint) behavior.

### AppRole auth

```javascript
const vaultClient = VaultClient.boot('main', {
    api: { url: 'https://vault.example.com:8200/' },
    auth: {
        type: 'appRole',
        mount: 'approle',                              // Optional. Vault AppRole auth mount point ("approle" by default)
        config: {
            role_id: '637c065f-c644-5e12-d3d1-e9fa4363af61', // Required. RoleID of the AppRole
            secret_id: '...',                          // Optional. Required when bind_secret_id is enabled
        },
    },
});
```

### Token auth

```javascript
const vaultClient = VaultClient.boot('main', {
    api: { url: 'https://vault.example.com:8200/' },
    auth: {
        type: 'token',
        mount: 'token',                                // Optional. Vault token auth mount point ("token" by default)
        config: {
            token: 's.xxxxxxxxxxxxxxxxxxxxxxxx',       // Required. Vault token
        },
    },
});
```

### Kubernetes auth

```javascript
const vaultClient = VaultClient.boot('main', {
    api: { url: 'https://vault.example.com:8200/' },
    auth: {
        type: 'kubernetes',
        mount: 'kubernetes',                           // Optional. Vault Kubernetes auth mount point ("kubernetes" by default)
        config: {
            role: 'my_k8s_role',                       // Required. Role configured in the Vault Kubernetes auth backend
            tokenPath: '/var/run/secrets/kubernetes.io/serviceaccount/token', // Optional. Defaults to the in-pod service-account token path
        },
    },
});
```

## API

<a name="VaultClient"></a>

### VaultClient 

* [VaultClient](#VaultClient)
    * [new VaultClient(options)](#new_VaultClient_new)
    * _instance_
        * [.fillNodeConfig()](#VaultClient+fillNodeConfig)
        * [.read(path)](#VaultClient+read) ⇒ <code>Promise.&lt;Lease&gt;</code>
        * [.list(path)](#VaultClient+list) ⇒ <code>Promise.&lt;Lease&gt;</code>
        * [.write(path, data)](#VaultClient+write) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.close()](#VaultClient+close)
    * _static_
        * [.boot(name, [options])](#VaultClient.boot) ⇒ <code>VaultClient</code>
        * [.get(name)](#VaultClient.get) ⇒ <code>VaultClient</code>
        * [.clear([name])](#VaultClient.clear)
* [Lease](#Lease)

<a name="new_VaultClient_new"></a>

#### new VaultClient(options)
Client constructor function.


| Param | Type | Default | Description |
| --- | --- | --- | --- |
| options | `Object` |  |  |
| options.api | <code>Object</code> |  |  |
| options.api.url | <code>String</code> |  | the url of the vault server |
| [options.api.apiVersion] | <code>String</code> | `v1` |  |
| [options.api.requestOptions] | <code>Object</code> |  | extra options merged into every HTTP request (see [Custom transport](#custom-transport-proxy--self-signed-tls)) |
| options.auth | <code>Object</code> |  |  |
| options.auth.type | <code>String</code> |  |  |
| [options.auth.mount] | <code>String</code> |  | Vault auth backend mount point; default varies per method (e.g. "aws" for iam, "approle", "token", "kubernetes") |
| options.auth.config | <code>Object</code> |  | auth configuration variables |
| [options.auth.config.namespace] | <code>String</code> |  | Optional. Vault namespace, sent as the `X-Vault-Namespace` header on all secret read/list/write requests. Applies to every auth type, not just IAM. |
| options.logger | <code>Object</code> | `false` |  | Logger that supports "error", "info", "warn", "trace", "debug" methods. Uses `console` by default. Pass `false` to disable logging. |

##### Custom transport (proxy / self-signed TLS)

`options.api.requestOptions` is shallow-merged into every underlying `fetch()` call, so you
can route traffic through a proxy/SOCKS agent or trust a self-signed / internal-CA Vault.
Pass an [undici](https://undici.nodejs.org/) `dispatcher` (request semantics like `method`
and `body` always win; `headers` are merged with per-request headers taking precedence):

```javascript
const { Agent, ProxyAgent } = require('undici');

// Trust an internal/self-signed CA (preferred over disabling verification)
const vaultClient = VaultClient.boot('main', {
    api: {
        url: 'https://vault.internal:8200/',
        requestOptions: {
            dispatcher: new Agent({ connect: { ca: require('fs').readFileSync('/etc/ssl/internal-ca.pem') } }),
        },
    },
    auth: { type: 'token', config: { token: '...' } },
});

// Route through an HTTP proxy / SOCKS agent
const proxied = VaultClient.boot('proxied', {
    api: { url: 'https://vault.example.com:8200/', requestOptions: { dispatcher: new ProxyAgent('http://proxy:8080') } },
    auth: { type: 'token', config: { token: '...' } },
});
```

For the self-signed-CA case you can also use the process-wide `NODE_EXTRA_CA_CERTS=/path/ca.pem`
env var with no code change. Only disable verification
(`new Agent({ connect: { rejectUnauthorized: false } })`) in throwaway/dev setups — it removes
MITM protection.

#### vaultClient.fillNodeConfig() ⇒ <code>Promise</code>
Populates Vault's values to NPM "config" module

Resolves once the npm `config` module has been populated from Vault.

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  
<a name="VaultClient+read"></a>

#### vaultClient.read(path) ⇒ <code>Promise.&lt;Lease&gt;</code>
Read secret from Vault

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path | <code>string</code> | path to the secret |

<a name="VaultClient+list"></a>

#### vaultClient.list(path) ⇒ <code>Promise.&lt;Lease&gt;</code>
Retrieves secrets list

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path | <code>string</code> | path to the secret |

<a name="VaultClient+write"></a>

#### vaultClient.write(path, data) ⇒ <code>Promise.&lt;Object&gt;</code>
Writes data to Vault

Resolves to the raw parsed Vault response body, which may be empty/undefined for
`204 No Content` responses.

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path |  | path used to write data |
| data | <code>object</code> | data to write |

<a name="VaultClient+close"></a>

#### vaultClient.close()
Release resources held by this client.

This client performs lease renewal for renewable auth tokens by arming a background timer.
That timer keeps the Node.js event loop alive, so a short-lived script (e.g. a one-off
`read`) never exits on its own. Call `close()` once you are done with the client to cancel
the timer and let the process exit. It is null-safe and safe to call multiple times. The
client may still be used afterwards — the next operation that fetches a renewable token
will arm a new refresh timer.

```javascript
const vaultClient = VaultClient.boot('main', { /* ... */ });
const secret = await vaultClient.read('secret/tst');
console.log(secret);
vaultClient.close(); // process can now exit
```

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

<a name="Lease"></a>

### Lease

The object returned by `read()` and `list()` (they resolve to `Promise<Lease>`). Use its
accessors to extract the secret data:

* `getValue(key)` ⇒ <code>String</code> — value for a single key. Throws `Requested key does not exist` when the key is absent.
* `getData()` ⇒ <code>Object</code> — a deep-cloned copy of the whole secret data object.
* `isRenewable()` ⇒ <code>boolean</code> — whether the underlying lease is renewable.

<a name="VaultClient.boot"></a>

#### VaultClient.boot(name, [options]) ⇒ <code>VaultClient</code>
Boot an instance of Vault

The instance will be stored in a local hash. Calling Vault.boot multiple
times with the same name will return the same instance.

**Kind**: static method of [<code>VaultClient</code>](#VaultClient)  
**Returns**: <code>VaultClient</code>  

| Param | Type | Description |
| --- | --- | --- |
| name | <code>String</code> | Vault instance name |
| [options] | <code>Object</code> | options for [Vault#constructor](#new_VaultClient_new). |

<a name="VaultClient.get"></a>

#### VaultClient.get(name) ⇒ <code>VaultClient</code>
Get an instance of Vault

The instance will be stored in a local hash. Calling Vault.pop multiple
times with the same name will return the same instance.

**Kind**: static method of [<code>VaultClient</code>](#VaultClient)  
**Returns**: <code>VaultClient</code>  

| Param | Type | Description |
| --- | --- | --- |
| name | <code>String</code> | Vault instance name |

<a name="VaultClient.clear"></a>

#### VaultClient.clear([name])
Clear named Vault instance

If no name passed all named instances will be cleared.

**Kind**: static method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| [name] | <code>String</code> | Vault instance name, all instances will be cleared if no name were passed |
