# Node.js Vault Client

![npm](https://img.shields.io/npm/v/node-vault-client)
![npm](https://img.shields.io/npm/dm/node-vault-client)

A Vault Client implemented in pure javascript for [HashiCorp Vault](https://github.com/hashicorp/vault).
It supports variety of Auth Backends and performs lease renewal for issued auth token.

## Install
```
npm install --save node-vault-client
```

## Example

```javascript
const VaultClient = require('node-vault-client');

const vaultClient = VaultClient.boot('main', {
    api: { url: 'https://vault.example.com:8200/' },
    auth: { 
        type: 'appRole', // or 'token', 'iam'
        config: { role_id: '637c065f-c644-5e12-d3d1-e9fa4363af61' } 
    },
});

vaultClient.read('secret/tst').then(v => {
    console.log(v);
}).catch(e => console.error(e));
```

## KV v2 support

This release adds transparent support for the [KV v2 secrets engine](https://developer.hashicorp.com/vault/docs/secrets/kv/kv-v2)
on top of the existing KV v1 / raw passthrough behaviour.

**It is fully opt-in and non-breaking.** With no extra configuration the client behaves exactly as
before: every path is treated as KV v1 / raw passthrough and no extra request is made. KV v2 is
activated per mount by setting `api.kv.autoDetect: true` **or** by supplying a static `api.engines`
map. Once enabled, the client rewrites paths (`secret/foo` → `secret/data/foo`) and unwraps the
nested KV v2 response automatically — callers never deal with the `data/` / `metadata/` segments
themselves.

### Configuration options

| Option | Type | Default | Description |
|---|---|---|---|
| `api.kv.autoDetect` | `boolean` | `false` | Auto-detect the KV version of each mount on first use via `GET sys/internal/ui/mounts/<path>`. The result is cached per mount for the lifetime of the client. |
| `api.engines` | `Object` | `{}` | Static mount-to-version map, e.g. `{ secret: 2, legacy: 1 }`. Listed mounts resolve with no detection round-trip; use this when the token lacks permission on `sys/internal/ui/mounts`. |

`engines` always takes precedence over detection, so the two can be combined: matching mounts use
the map while unmatched mounts are auto-detected (when `autoDetect: true`) or treated as v1.

### KV v1 (default — nothing to configure)

```javascript
const client = VaultClient.boot('main', {
    api: { url: 'https://vault.example.com:8200/' },
    auth: { type: 'token', config: { token: '...' } },
});

const lease = await client.read('secret/my-app/config'); // GET secret/my-app/config
console.log(lease.getData());      // the secret object
console.log(lease.getMetadata());  // undefined on KV v1
```

### KV v2

Pass **logical** paths only — the client inserts the `data/` (and `metadata/` for `list`) segment
for you.

```javascript
const client = VaultClient.boot('main', {
    api: {
        url: 'https://vault.example.com:8200/',
        engines: { secret: 2 },          // or: kv: { autoDetect: true }
    },
    auth: { type: 'token', config: { token: '...' } },
});

// read  → GET    secret/data/my-app/config, response.data.data is unwrapped automatically
const lease = await client.read('secret/my-app/config');
console.log(lease.getData());      // the secret values
console.log(lease.getMetadata());  // { version, created_time, ... } on KV v2

// write → POST   secret/data/my-app/config with { data: { ... } } wrapping done for you
await client.write('secret/my-app/config', { password: 's3cr3t' });

// list  → LIST   secret/metadata/my-app
await client.list('secret/my-app');
```

### Mixed v1 + v2 mounts on one client

Version resolution is **per mount**, so a single client can talk to v1 and v2 mounts at the same
time. List each mount's version in `api.engines`:

```javascript
const client = VaultClient.boot('main', {
    api: {
        url: 'https://vault.example.com:8200/',
        engines: {
            'secret-v2': 2,   // KV v2 mount
            // 'secret' is not listed → treated as KV v1 (passthrough)
        },
    },
    auth: { type: 'token', config: { token: '...' } },
});

await client.read('secret/legacy/app');        // v1 → GET secret/legacy/app
await client.read('secret-v2/app/config');     // v2 → GET secret-v2/data/app/config
await client.read('database/creds/app-role');  // not KV  → passthrough, GET as-is
```

Or let the client figure it out with `autoDetect` (requires the token to read
`sys/internal/ui/mounts`):

```javascript
const client = VaultClient.boot('main', {
    api: { url: 'https://vault.example.com:8200/', kv: { autoDetect: true } },
    auth: { type: 'token', config: { token: '...' } },
});

await client.read('secret/legacy/app');     // detected as v1
await client.read('secret-v2/app/config');  // detected as v2
```

### Notes & caveats

- **Do not include KV v2 segments in the path.** Pass `secret/foo`, not `secret/data/foo` — the
  latter would be rewritten to `secret/data/data/foo` on a v2 mount.
- **Vault policy must allow the v2 paths.** KV v2 reads hit `<mount>/data/...` (and `list` hits
  `<mount>/metadata/...`), so the auth token's policy must grant capabilities on those paths, not
  on the logical path.
- Non-KV backends (database, transit, etc.) are always treated as passthrough — leave them out of
  `api.engines`, and `autoDetect` recognises them as non-KV automatically.
- If detection fails (e.g. permission denied) and no `api.engines` override matches, the read
  rejects with a `VaultError` — set `api.engines` to bypass detection in that case.
- A detection answer without a string `path` and `type` fails the call and is not cached, and an
  answer whose mount does not contain the requested path is rejected for that caller only. Auth
  mounts are cached as `auth/<mount>`, so they never collide with a secrets mount of the same name.

## Path validation

Since 1.0.4, `read`, `list` and `write` reject a path with `InvalidArgumentsError`, before any
request is sent (including the login and mount detection), when Vault or the HTTP stack would
resolve it to a different path than the one passed (GHSA-rr65-m54w-rfr9, GHSA-wf8v-q2h3-hgjm):

- an empty path, or one that is not a string;
- `?`, `#`, `\`, a control character (U+0000–U+001F, U+007F), an unpaired surrogate or a
  trailing space;
- a percent-encoded `.`, `/`, `\` or `%` (`%2e`, `%2f`, `%5c`, `%25`, in any case);
- an empty segment such as `a//b`, which the client used to collapse into `a/b` before sending, so
  `tenants/${id}/key` with an empty `id` addressed `tenants/key`;
- a `.` or `..` segment, which Vault redirects to the cleaned path and the client followed with its
  token;
- a percent-encoded mount (`secre%74/foo`, or `team/k%76/foo` for the mount `team/kv`).

Leading slashes are dropped before the mount is resolved, so `/secret/foo` and `secret/foo`
address the same key. One trailing slash is kept, as in `list('secret/apps/')`. A key name that
needs `?` or `#` can still be addressed percent-encoded (`%3F`, `%23`).

These checks stop a path from reaching a different Vault path than the one it names; they do not
stop a caller from naming another tenant's key, so keep validating lower-trust input that goes
into a path. A validation error's message says which rule failed but not the path.

## Logging

The default logger writes `error`, `warn`, `info` and `trace` to `console` and discards `debug`. A
custom logger must implement all five methods; one missing any of them is silently replaced by the
default logger. Since 1.0.4 no log line, at any level, carries a Vault token, the AppRole
`role_id`/`secret_id`, the Kubernetes JWT or a Vault response body: request logs name the method
and URL, auth logs name the token accessor, and failure logs keep only the HTTP status and Vault's
`errors` strings. Errors the client throws still carry the request in `err.options` (including the
`X-Vault-Token` header) and the response in `err.response`, but these are no longer printed when
the error is logged or serialised; the `StatusCodeError` message is still `"<status> - <body>"`, so
log `err.statusCode` and `err.error.errors` rather than the message if the body may hold secrets.

## Supported Auth Backends

* [AWS IAM](https://www.vaultproject.io/docs/auth/aws.html#iam-auth-method)
* [AppRole](https://www.vaultproject.io/docs/auth/approle.html)
* [Token](https://www.vaultproject.io/docs/auth/token.html)

## API

<a name="VaultClient"></a>

### VaultClient 

* [VaultClient](#VaultClient)
    * [new VaultClient(options)](#new_VaultClient_new)
    * _instance_
        * [.fillNodeConfig()](#VaultClient+fillNodeConfig)
        * [.read(path)](#VaultClient+read) ⇒ <code>Promise.&lt;Lease&gt;</code>
        * [.list(path)](#VaultClient+list) ⇒ <code>Promise.&lt;Lease&gt;</code>
        * [.write(path, data)](#VaultClient+write) ⇒ <code>Promise.&lt;(T\|never)&gt;</code>
    * _static_
        * [.boot(name, [options])](#VaultClient.boot) ⇒
        * [.get(name)](#VaultClient.get) ⇒
        * [.clear([name])](#VaultClient.clear)

<a name="new_VaultClient_new"></a>

#### new VaultClient(options)
Client constructor function.


| Param | Type | Default | Description |
| --- | --- | --- | --- |
| options | `Object` |  |  |
| options.api | <code>Object</code> |  |  |
| options.api.url | <code>String</code> |  | the url of the vault server |
| [options.api.apiVersion] | <code>String</code> | `v1` |  |
| [options.api.kv] | <code>Object</code> |  | KV engine options |
| [options.api.kv.autoDetect] | <code>boolean</code> | `false` | Auto-detect the KV version per mount via `GET sys/internal/ui/mounts/<path>`. |
| [options.api.engines] | <code>Object</code> | `{}` | Static mount-to-version map, e.g. `{ secret: 2, legacy: 1 }`. Overrides detection. |
| options.auth | <code>Object</code> |  |  |
| options.auth.type | <code>String</code> |  |  |
| options.auth.config | <code>Object</code> |  | auth configuration variables |
| [options.logger] | <code>Object</code> \| <code>false</code> |  | Logger that implements all five of "error", "warn", "info", "debug" and "trace"; one missing any of them is silently replaced by the default logger. The default logger writes to `console`, except `debug`, which is discarded. Pass `false` to disable logging. See [Logging](#logging). |

#### vaultClient.fillNodeConfig()
Populates Vault's values to NPM "config" module

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

#### vaultClient.write(path, data) ⇒ <code>Promise.&lt;(T\|never)&gt;</code>
Writes data to Vault

**Kind**: instance method of [<code>VaultClient</code>](#VaultClient)  

| Param | Type | Description |
| --- | --- | --- |
| path |  | path used to write data |
| data | <code>object</code> | data to write |

<a name="VaultClient.boot"></a>

#### VaultClient.boot(name, [options]) ⇒
Boot an instance of Vault

The instance will be stored in a local hash. Calling Vault.boot multiple
times with the same name will return the same instance.

**Kind**: static method of [<code>VaultClient</code>](#VaultClient)  
**Returns**: Vault  

| Param | Type | Description |
| --- | --- | --- |
| name | <code>String</code> | Vault instance name |
| [options] | <code>Object</code> | options for [Vault#constructor](#new_VaultClient_new). |

<a name="VaultClient.get"></a>

#### VaultClient.get(name) ⇒
Get an instance of Vault

The instance will be stored in a local hash. Calling Vault.pop multiple
times with the same name will return the same instance.

**Kind**: static method of [<code>VaultClient</code>](#VaultClient)  
**Returns**: Vault  

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
