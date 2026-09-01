# Node.js Vault Client

[![Build Status](https://img.shields.io/github/actions/workflow/status/namecheap/node-vault-client/pipeline.yaml?branch=master&style=flat-square)](https://github.com/namecheap/node-vault-client/actions/workflows/pipeline.yaml)
[![Download Status](https://img.shields.io/npm/dm/node-vault-client.svg?style=flat-square)](https://www.npmjs.com/package/node-vault-client)
[![NPM Version](https://img.shields.io/npm/v/node-vault-client?style=flat-square)](https://www.npmjs.com/package/node-vault-client)
[![License](https://img.shields.io/npm/l/node-vault-client?style=flat-square)](https://github.com/namecheap/node-vault-client/blob/master/LICENSE.txt)
[![Dependency Status](https://img.shields.io/librariesio/release/npm/node-vault-client.svg?style=flat-square)](https://libraries.io/npm/node-vault-client/)

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
        type: 'appRole', // one of: 'appRole' | 'token' | 'iam' | 'kubernetes' | 'jwt'
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
* [JWT](https://developer.hashicorp.com/vault/docs/auth/jwt)

### AWS IAM auth

```javascript
const vaultClient = VaultClient.boot('main', {
    api: {
        url: 'https://vault.example.com:8200/',
        namespace: 'some_namespace',                   // Optional. X-Vault-Namespace header (canonical location; auth.config.namespace is honored as a legacy fallback)
    },
    auth: {
        type: 'iam',
        mount: 'aws',                                  // Optional. Vault AWS auth mount point ("aws" by default)
        config: {
            role: 'my_iam_role',
            iam_server_id_header_value: 'https://vault.example.com:8200/', // Optional. X-Vault-AWS-IAM-Server-ID header
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

### JWT auth

```javascript
const vaultClient = VaultClient.boot('main', {
    api: { url: 'https://vault.example.com:8200/' },
    auth: {
        type: 'jwt',
        mount: 'jwt',                                  // Optional. Vault JWT auth mount point ("jwt" by default)
        config: {
            role: 'my-app',                             // Optional. Role configured in Vault's JWT auth backend; omitted uses the mount's `default_role`
            jwt: process.env.CI_JOB_JWT,                // Exactly one of `jwt` / `jwtPath` / `jwtProvider` is required (see below)
        },
    },
});
```

Exactly one of three mutually exclusive `config` keys supplies the JWT:

* **`jwt`** — a literal token string. Use it for CI jobs and other processes that are guaranteed
  to finish before the token expires. Caveat: the value is fixed at construction, so if the
  client re-authenticates (its Vault-issued token TTL runs out while the process is still up) it
  re-sends that exact same JWT — which works only until the IdP-issued token itself expires,
  after which Vault rejects every further login attempt. Do not use `jwt` in a long-running
  process.
* **`jwtPath`** — path to a file containing the JWT, re-read on every login (mirrors
  [Kubernetes auth](#kubernetes-auth)'s `tokenPath`). Use it for rotated *projected* tokens, such
  as a Kubernetes projected service-account token the kubelet refreshes on disk, so each login
  picks up whatever is currently on disk instead of a token captured once at startup.
* **`jwtProvider`** — an (optionally async) function, called fresh at login time (never at
  construction, never cached), returning `string | Promise<string>`. Use it when the JWT has to
  be minted per login — GitHub Actions' `core.getIDToken()`, a cloud metadata endpoint, a
  SPIFFE/SPIRE workload API.

#### Authenticating from GitHub Actions

```yaml
permissions:
  id-token: write
```

```javascript
const core = require('@actions/core');
const VaultClient = require('node-vault-client');

const vaultClient = VaultClient.boot('ci', {
    api: { url: process.env.VAULT_ADDR },
    auth: {
        type: 'jwt',
        mount: 'gha',                                  // matches wherever the JWT method was mounted, e.g. `vault auth enable -path=gha jwt`
        config: { role: 'ci', jwtProvider: () => core.getIDToken('vault') },
    },
});
```

`role` is optional here too — omit it to use the mount's `default_role`. `mount` and
`api.namespace` behave exactly as they do for the other four backends.

Vault's JWT method also offers an interactive `oidc` login (a browser redirect for a human user).
This library implements only the non-interactive `jwt` flow: a service client doing headless
background renewal has no browser to redirect to, so `oidc` is deliberately not supported.

### Token renewal

Whenever Vault issues a **renewable** token, the client arms a background timer and renews it at
half its remaining lifetime, for as long as the client lives. That is the default and suits
long-running services.

Set `renewal: false` on the `auth` block (beside `type`, not inside `config`) to turn it off:

```javascript
auth: {
    type: 'appRole',
    renewal: false,
    config: {
        role_id: '637c065f-...',
        secret_id: '...',
    },
}
```

These keys sit on `auth` rather than in `auth.config` on purpose: `config` is the backend's own
credential bag and may already carry keys of your own, so reserving names inside it could break an
existing caller. Same reasoning that put the namespace at `api.namespace`.

With renewal off, the client keeps using the token until it expires and then simply logs in again
on the next call — no background timer at all. Two reasons to want that:

* **Short-lived processes.** The renewal timer keeps the Node.js event loop alive, so a script that
  finishes its work does not exit on its own; you have to call
  [`close()`](#VaultClient+close). With `renewal: false` there is no timer to hold it open.
* **You would rather re-authenticate than renew** — for example where the auth backend can always
  mint a fresh token (`jwtProvider`, Kubernetes, IAM) and you prefer a clean login over extending
  an existing lease.

#### Before you turn it off

Renewal off means the token is allowed to expire, and what happens next depends on whether your
backend can obtain a *fresh* credential unaided:

| backend | on expiry with `renewal: false` |
| --- | --- |
| `kubernetes`, `iam`, `jwt` with `jwtPath`/`jwtProvider` | clean re-login — the JWT or AWS credential is re-acquired, so this is the intended case |
| `appRole` | re-login **replays the same `secret_id`**. Fine for a reusable one; with Vault's recommended hardening (`secret_id_num_uses=1`, or a short `secret_id_ttl`) the second login is rejected |
| `jwt` with a literal `jwt` | replays the same JWT, so it works only until the IdP-issued token expires |
| `token` | **cannot re-authenticate at all.** The client raises `AuthTokenExpiredError` from then on, permanently |

Two consequences worth stating plainly:

* For `token` auth this **is** a behaviour change, not a no-op. A renewable token handed to `token`
  auth is renewed indefinitely today; with `renewal: false` it expires and every later call rejects
  for the life of the process. `close()` does not reset it — recovery means
  `VaultClient.clear(name)` and booting again.
* For `appRole` and literal-`jwt`, a login that can no longer succeed is retried on **every**
  subsequent call, since a failed login clears the cached token. That is a failing request per
  `read()`, with no backoff. Prefer `jwtPath`/`jwtProvider`, a reusable `secret_id`, or leaving
  renewal on.

**Expiring a token also revokes its leases.** Vault revokes every lease created by a token when
that token expires, and this client does not renew secret leases — only the auth token. If you read
dynamic credentials (`database/creds/*`, cloud credentials) whose lease outlives the auth token,
leaving renewal on is what currently keeps them alive. KV reads are unaffected.

#### Tuning renewal instead of disabling it

Two further keys, also on `auth`, shape *how* renewal happens. Both are optional, and leaving them
out reproduces the behaviour the client has always had.

| key | default | meaning |
| --- | --- | --- |
| `renewalFraction` | `0.5` | How much of the token's **remaining** lifetime to wait before renewing, as a fraction in `(0, 1)`. `0.5` renews at the halfway point. |
| `renewalIncrement` | *(unset)* | Seconds of extra TTL to ask for, sent as `increment` to `auth/token/renew-self`. Unset means Vault applies the token's own period. |

```javascript
auth: {
    type: 'kubernetes',
    renewalFraction: 0.25,   // renew after a quarter of the remaining lifetime
    renewalIncrement: 3600,  // ask Vault for another hour each time
    config: { role: 'my-app' },
}
```

Lower `renewalFraction` values renew earlier and more often, which buys headroom if Vault is briefly
unreachable. A failed renewal is retried on the same rule against the *same* token, so the waits
shrink geometrically as the remaining lifetime does — for a 1-hour token that is roughly 12 attempts
at `0.5` (1800s, 900s, 450s, …) versus 27 at `0.25`, both bottoming out at a 1-second floor just
before expiry. Higher values renew later and talk to Vault less.

`renewalIncrement` is a request, not a guarantee: Vault grants at most the token's max TTL and may
return less. Both keys are validated at construction — a `renewalFraction` outside `(0, 1)` or a
non-positive/non-integer `renewalIncrement` raises `InvalidArgumentsError` rather than failing later
inside a background timer.

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
        * [.delete(path)](#VaultClient+delete) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.update(path, data)](#VaultClient+update) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.request(method, path, [data])](#VaultClient+request) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.deleteVersions(path, versions)](#VaultClient+deleteVersions) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.undeleteVersions(path, versions)](#VaultClient+undeleteVersions) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.destroyVersions(path, versions)](#VaultClient+destroyVersions) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.readMetadata(path)](#VaultClient+readMetadata) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.deleteMetadata(path)](#VaultClient+deleteMetadata) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.close()](#VaultClient+close)
    * _static_
        * [.boot(name, options)](#VaultClient.boot) ⇒ <code>VaultClient</code>
        * [.get(name)](#VaultClient.get) ⇒ <code>VaultClient</code>
        * [.clear([name])](#VaultClient.clear)
* [Lease](#Lease)

**Return contract**: [`read()`](#VaultClient+read) and [`list()`](#VaultClient+list) resolve to a
[`Lease`](#Lease) — use its accessors to extract the secret data. Every other data-plane method
(`write`, `delete`, `update`, `request` and the KV v2 helpers) resolves to the raw parsed Vault
response body, which may be empty/undefined for `204 No Content` responses.

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
| [options.api.namespace] | <code>String</code> |  | Optional. Vault namespace, sent as the `X-Vault-Namespace` header on **every** request — login, token lookup/renewal, and all secret operations — for every auth type. This is the canonical location; `auth.config.namespace` is still honored for backward compatibility. |
| [options.api.kv.autoDetect] | <code>boolean</code> | `false` | auto-detect the KV version of each mount on first use (see [KV v2 & generic backends](#kv-v2--generic-backends)) |
| [options.api.engines] | <code>Object</code> | `{}` | static mount-to-version map, e.g. `{ secret: 2, legacy: 1 }` (see [KV v2 & generic backends](#kv-v2--generic-backends)) |
| options.auth | <code>Object</code> |  |  |
| options.auth.type | <code>String</code> |  | one of: 'appRole' \| 'token' \| 'iam' \| 'kubernetes' \| 'jwt' |
| [options.auth.mount] | <code>String</code> |  | Vault auth backend mount point; default varies per method (e.g. "aws" for iam, "approle", "token", "kubernetes", "jwt") |
| options.auth.config | <code>Object</code> |  | auth configuration variables |
| [options.auth.config.namespace] | <code>String</code> |  | Optional. Legacy location for the Vault namespace (see `api.namespace`). Sent as the `X-Vault-Namespace` header on **every** request for every auth type. |
| [options.auth.renewal] | <code>boolean</code> | <code>true</code> | Set `false` to never renew the Vault token in the background; the token is used until it expires and the next call re-authenticates. See [Token renewal](#token-renewal). |
| [options.auth.renewalFraction] | <code>number</code> | <code>0.5</code> | How much of the token's remaining lifetime to wait before renewing, as a fraction in `(0, 1)`. |
| [options.auth.renewalIncrement] | <code>number</code> |  | Seconds of extra TTL to request on each renewal, sent as `increment` to `auth/token/renew-self`. Vault caps it at the token's max TTL. |
| [options.logger] | <code>Object</code> \| <code>false</code> |  | Logger that must implement **all five** of "error", "warn", "info", "debug" and "trace" — an object missing any one of them is silently ignored and the default logger is used instead. The default logger writes to `console`, except `debug`, which is discarded so that sensitive data is never printed. Pass `false` to disable logging entirely. |

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

<a name="VaultClient+fillNodeConfig"></a>

#### vaultClient.fillNodeConfig() ⇒ <code>Promise</code>
Populates Vault's values to NPM "config" module

Resolves once the npm `config` module has been populated from Vault. Note that setup failures are thrown **synchronously**, not returned as a rejected promise: a missing `config` peer dependency and an unreadable `<NODE_CONFIG_DIR>/custom-vault-variables.js` both throw `VaultError` before the promise is created, so use `await` or wrap the call in `try`/`catch` rather than relying on `.catch()` alone.

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
| path | <code>string</code> | path used to write data |
| data | <code>object</code> | data to write |

<a name="VaultClient+delete"></a>

#### vaultClient.delete(path) ⇒ <code>Promise.&lt;Object&gt;</code>
Deletes a secret

On KV v2 mounts this sends `DELETE` to the `data/` path, soft-deleting the latest version.
On KV v1 / non-KV mounts this sends `DELETE` to the raw path. Resolves to the raw parsed
Vault response body, which may be empty/undefined for `204 No Content` responses.

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path | <code>string</code> | path to the secret |

<a name="VaultClient+update"></a>

#### vaultClient.update(path, data) ⇒ <code>Promise.&lt;Object&gt;</code>
Updates (merge-patches) a KV v2 secret

Sends `PATCH` with `Content-Type: application/merge-patch+json`, merging `data` into the
existing secret without overwriting keys that are not listed. KV v2 merge-patch operation —
KV v1 mounts do not support `PATCH` and Vault returns `405` there. Resolves to the raw
parsed Vault response body.

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path | <code>string</code> | path to the secret |
| data | <code>object</code> | keys to merge into the existing secret |

<a name="VaultClient+request"></a>

#### vaultClient.request(method, path, [data]) ⇒ <code>Promise.&lt;Object&gt;</code>
Raw request — escape hatch for any Vault backend

Sends the literal API path with no KV path rewriting and no response unwrapping, and
resolves to the parsed response body. Use it for non-KV backends (e.g. Transit) or when you
have already constructed the complete Vault API path.

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| method | <code>string</code> | HTTP method (e.g. `GET`, `POST`) |
| path | <code>string</code> | literal API path, sent as-is |
| [data] | <code>object</code> | request body |

<a name="VaultClient+deleteVersions"></a>

#### vaultClient.deleteVersions(path, versions) ⇒ <code>Promise.&lt;Object&gt;</code>
Soft-deletes specific versions of a KV v2 secret

KV v2 only — rejects with `UnsupportedOperationError` on non-v2 mounts. Resolves to the raw
parsed Vault response body.

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path | <code>string</code> | path to the secret |
| versions | <code>Array.&lt;number&gt;</code> | version numbers to soft-delete |

<a name="VaultClient+undeleteVersions"></a>

#### vaultClient.undeleteVersions(path, versions) ⇒ <code>Promise.&lt;Object&gt;</code>
Undeletes (restores) soft-deleted versions of a KV v2 secret

KV v2 only — rejects with `UnsupportedOperationError` on non-v2 mounts. Resolves to the raw
parsed Vault response body.

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path | <code>string</code> | path to the secret |
| versions | <code>Array.&lt;number&gt;</code> | version numbers to restore |

<a name="VaultClient+destroyVersions"></a>

#### vaultClient.destroyVersions(path, versions) ⇒ <code>Promise.&lt;Object&gt;</code>
Permanently destroys specific versions of a KV v2 secret

The destroyed version data cannot be recovered. KV v2 only — rejects with
`UnsupportedOperationError` on non-v2 mounts. Resolves to the raw parsed Vault response body.

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path | <code>string</code> | path to the secret |
| versions | <code>Array.&lt;number&gt;</code> | version numbers to destroy |

<a name="VaultClient+readMetadata"></a>

#### vaultClient.readMetadata(path) ⇒ <code>Promise.&lt;Object&gt;</code>
Reads KV v2 metadata for a secret

Resolves to the raw parsed Vault response body; the metadata document (`current_version`, the `versions` map, timestamps, etc.) is under its `data` property, e.g. `(await client.readMetadata('secret/foo')).data.current_version`.
KV v2 only — rejects with `UnsupportedOperationError` on non-v2 mounts.

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path | <code>string</code> | path to the secret |

<a name="VaultClient+deleteMetadata"></a>

#### vaultClient.deleteMetadata(path) ⇒ <code>Promise.&lt;Object&gt;</code>
Deletes all metadata and version history for a KV v2 secret (permanent)

KV v2 only — rejects with `UnsupportedOperationError` on non-v2 mounts. Resolves to the raw
parsed Vault response body, which may be empty/undefined for `204 No Content` responses.

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path | <code>string</code> | path to the secret |

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

#### VaultClient.boot(name, options) ⇒ <code>VaultClient</code>
Boot an instance of Vault

The instance will be stored in a local hash. Calling Vault.boot multiple
times with the same name will return the same instance.

**Kind**: static method of [<code>VaultClient</code>](#VaultClient)  
**Returns**: <code>VaultClient</code>  

| Param | Type | Description |
| --- | --- | --- |
| name | <code>String</code> | Vault instance name |
| options | <code>Object</code> | options for [Vault#constructor](#new_VaultClient_new). Required on every call, including for a name that was already booted — use [VaultClient.get(name)](#VaultClient.get) to fetch an existing instance. |

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

## KV v2 & generic backends

### Overview

By default the client behaves exactly as before (KV v1 / raw passthrough). To enable transparent
KV v2 support set `api.kv.autoDetect: true` **or** supply a static `api.engines` map. Either
option activates path-rewriting and response-unwrapping; callers do not need to know the engine
version.

### Configuration options

| Option | Type | Default | Description |
|---|---|---|---|
| `api.kv.autoDetect` | `boolean` | `false` | Auto-detect the KV version of each mount on first use via `GET sys/internal/ui/mounts/<path>`. |
| `api.engines` | `Object` | `{}` | Static mount-to-version map, e.g. `{ secret: 2, legacy: 1 }`. Overrides detection; use this when the token lacks permission on `sys/internal/ui/mounts`. |

Both options can be combined: `engines` acts as an override — matching mounts skip detection
while unmatched mounts are auto-detected (when `autoDetect: true`).

### Auto-detect example

```javascript
const client = VaultClient.boot('main', {
    api: {
        url: 'https://vault.example.com:8200/',
        kv: { autoDetect: true },
    },
    auth: { type: 'token', config: { token: '...' } },
});

// Works transparently on both KV v1 and KV v2 mounts
const lease = await client.read('secret/my-app/config');
console.log(lease.getData());         // the secret object
console.log(lease.getMetadata());     // KV v2 version metadata (undefined on v1)
```

### Static engines override example

```javascript
const client = VaultClient.boot('main', {
    api: {
        url: 'https://vault.example.com:8200/',
        engines: { secret: 2, legacy: 1 },
    },
    auth: { type: 'token', config: { token: '...' } },
});
```

### KV v2-specific methods

These methods require a KV v2 mount and throw `UnsupportedOperationError` on v1 / non-KV mounts. They also require the mount to be *resolved* as v2: with neither `api.kv.autoDetect: true` nor an `api.engines` entry covering the mount, every path resolves as v1 passthrough with no detection call, and these methods fail with `UnsupportedOperationError` (`Mount "secret" is not a KV v2 engine.`) even against a genuine KV v2 mount.

```javascript
// Soft-delete specific versions
await client.deleteVersions('secret/foo', [1, 2]);

// Restore soft-deleted versions
await client.undeleteVersions('secret/foo', [1]);

// Permanently destroy versions
await client.destroyVersions('secret/foo', [1, 2]);

// Read version metadata. The full Vault envelope is returned, so the metadata
// fields live under `.data` (meta.data.current_version, meta.data.versions, ...)
const meta = await client.readMetadata('secret/foo');

// Delete all metadata and version history (permanent)
await client.deleteMetadata('secret/foo');
```

### update() — merge-patch

```javascript
// PATCH a subset of keys without overwriting others (KV v2)
await client.update('secret/foo', { password: 'new-value' });
// Sends PATCH secret/data/foo with Content-Type: application/merge-patch+json
```

### delete()

```javascript
// Soft-delete the latest version on KV v2; DELETE on v1/passthrough
await client.delete('secret/foo');
```

### request() — raw escape hatch

For any Vault backend that does not benefit from KV path rewriting use `request()`. It sends the
literal path with no rewriting or response normalisation and returns the parsed body directly.

```javascript
// Encrypt with Transit engine — path must not be rewritten
const result = await client.request('POST', 'transit/encrypt/my-key', {
    plaintext: Buffer.from('hello').toString('base64'),
});
console.log(result.data.ciphertext);
```

### Lease.getMetadata()

`getMetadata()` is additive — existing code is unaffected.

```javascript
const lease = await client.read('secret/my-app/db');
lease.getData();     // the secret values
lease.getMetadata(); // { version, created_time, deletion_time, destroyed, custom_metadata }
                     // undefined on KV v1 / passthrough mounts
```

### Path requirements when autoDetect / engines are active

When `autoDetect: true` or `api.engines` is set, the client rewrites logical paths to the
correct KV v2 API paths automatically (e.g. `secret/foo` → `secret/data/foo` for reads).
**Callers must pass logical paths — do not include the internal KV v2 segments** (`data/`,
`metadata/`, `delete/`, `undelete/`, `destroy/`) in the path argument:

```javascript
// Correct — logical path only
await client.read('secret/my-app/config');

// Wrong — double-rewrite: 'secret/data/foo' becomes 'secret/data/data/foo' on the wire
await client.read('secret/data/foo');
```

If you need to send a fully-literal Vault API path (e.g. when working with non-KV backends or
when you have already constructed the complete path), use `request()` which bypasses all path
rewriting:

```javascript
// Literal path, no rewriting
await client.request('GET', 'secret/data/foo');
```

### Mount detection caching

- Each canonical mount is detected once and then cached for the life of the `VaultClient` instance. The cache is a bounded LRU with a fixed cap of 500 mounts (not configurable through client options); a long-lived client that touches more than 500 distinct mounts evicts the least-recently-used entries, and an evicted mount is detected again on its next use.
- Concurrent first-touch requests for the same mount share a single in-flight detection promise.
- The detection endpoint used is `GET sys/internal/ui/mounts/<path>` (readable by any authenticated token).
- When the token lacks permission on that endpoint, set `api.engines` to skip detection.

### Error classes

Every error the client raises extends `VaultError`. The package entry point exports the
`VaultClient` class only, so the classes themselves are imported from `node-vault-client/src/errors`:

```javascript
const errors = require('node-vault-client/src/errors');

try {
    await client.readMetadata('secret/app');
} catch (err) {
    if (err instanceof errors.UnsupportedOperationError) {
        // the mount did not resolve as KV v2 - see "Path requirements" above
        return null;
    }
    throw err;
}
```

| Class | Extends | When thrown |
|---|---|---|
| `VaultError` | `Error` | Base class for every error below. Raised directly when mount detection fails (e.g. permission denied) and no `api.engines` override was provided. |
| `VaultHttpError` | `VaultError` | Vault answered with a non-2xx status. Carries the status as `statusCode` and the parsed body as `error`. |
| `InvalidArgumentsError` | `VaultError` | Bad arguments or configuration: `boot()` called without options, an unknown instance name passed to `get()`, an unsupported `auth.type`, invalid renewal options, or an invalid node-config substitution map. |
| `InvalidAWSCredentialsError` | `InvalidArgumentsError` | `auth.config.credentials` was supplied but is not a usable `accessKeyId` / `secretAccessKey` pair. |
| `AuthTokenExpiredError` | `VaultError` | The Vault token expired and the backend cannot obtain a new one. `token` auth can never re-authenticate; other backends reach this only with `renewal: false` and a credential they cannot replay. |
| `UnsupportedOperationError` | `VaultError` | A v2-only method (`deleteVersions`, `undeleteVersions`, `destroyVersions`, `readMetadata`, `deleteMetadata`) was called against a mount that did not resolve as KV v2. |

## Contributing

Contributions are welcome! Please read the [contributing guide](CONTRIBUTING.md) to get started,
and note that this project requires a [DCO sign-off](CONTRIBUTING.md#dco-sign-off) on every commit.

## Getting help

Not sure where to start? See [SUPPORT.md](SUPPORT.md).

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## Security

To report a security vulnerability, please follow our [Security Policy](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE.txt).
