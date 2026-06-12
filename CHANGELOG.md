# 2.0.0. Release notes (2026-06-12)

- Fix a process that never exits after reading with a renewable token. The background
  token-refresh timer (`long-timeout`) kept the Node.js event loop alive with no way to stop
  it. Add `VaultClient#close()` (and `VaultBaseAuth#cancelTokenRefresh()`) to cancel the timer
  so short-lived scripts can exit; `VaultClient.clear()` now also closes the instances it
  removes. Default behavior is unchanged — long-running servers keep renewing as before. Closes #31.
- IAM auth: add an optional `region` config option. When set, the STS
  `GetCallerIdentity` request is signed against the regional endpoint
  (`sts.<region>.amazonaws.com`) and the SigV4 credential scope is bound to that
  region, with the signed Host header and `iam_request_url` kept consistent.
  Fixes `SignatureDoesNotMatch — Credential should be scoped to a valid region`
  on non-`us-east-1` STS endpoints. Omitting `region` preserves the previous
  global-endpoint behavior. Closes #25.
- Add `api.requestOptions`, shallow-merged into every underlying `fetch()` request. Enables
  routing traffic through a proxy/SOCKS agent and trusting a self-signed / internal-CA Vault by
  passing an undici `dispatcher`. Closes #37 and #29.
- Replace the deprecated `request`/`request-promise` HTTP libraries with Node's native `fetch`.
  Removes the `request` runtime dependency and clears the associated Dependabot/deprecation
  alerts; this is the foundation for the new `api.requestOptions` (undici dispatcher) support.
  Closes #59.
- [BREAKING] Minimum supported Node.js is now 18.0.0 (was 14.0.0); the client relies on native `fetch`.
- Auth token: derive expiry from Vault's authoritative `expire_time` (RFC3339), falling back to
  `ttl` only when absent. Closes #51.
- Raise `AuthTokenExpiredError` for expired non-refreshable tokens instead of silently using a
  stale token. Closes #50.
- Replace deprecated `new Buffer()` with `Buffer.from()` in IAM auth STS body encoding. Closes #52.

# 1.0.0. Release notes (2023-08-02)

- `aws-sdk` is no longer a peer dependency
- [BREAKING] From now on the minimum supported version of Node.js is 14.0.0.
- [BREAKING] Changes in IAM configuration. If you explicitly passed aws-sdk@2 credentials to `VaultClient.boot` like below:
```js
    const vaultClient = VaultClient.boot('main', {
    api: {url: 'https://vault.example.com:8200/'},
    auth: {
        type: 'iam',
        mount: 'example',
        config: {
            iam_server_id_header_value: 'example',
            role: 'example',
            credentials: AWS.CredentialProviderChain.defaultProviders  // <-- this line
        }
    },
});
```
This will no longer work. You need to either:
- Do not pass the credentials at all and rely on the credentials auto-discovery
```js    
const vaultClient = VaultClient.boot('main', {
    api: {url: 'https://vault.example.com:8200/'},
    auth: {
        type: 'iam',
        mount: 'example',
        config: {
            iam_server_id_header_value: 'example',
            role: 'example',
        }
    },
});
```
[OR]
- Pass the credentials explicitly in the following format
```js
const vaultClient = VaultClient.boot('main', {
    api: {url: 'https://vault.example.com:8200/'},
    auth: {
        type: 'iam',
        mount: 'example',
        config: {
            iam_server_id_header_value: 'example',
            role: 'example',
            credentials: {
                accessKeyId: 'AWS_ACCESS_KEY',
                secretAccessKey: 'AWS_SECRET_KEY',
            }
        }
    },
});
```
