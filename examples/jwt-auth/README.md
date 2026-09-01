# JWT / OIDC auth demo

A single-file app that exercises the `jwt` auth backend against a **real Vault**, covering the
positive paths and the ways it is meant to fail. It doubles as a smoke test: it prints what each
scenario did and exits non-zero if any of them behaves differently than documented.

```bash
docker compose up -d --wait            # from the repo root
node examples/jwt-auth/vault-jwt-demo.mjs
```

Against another Vault:

```bash
VAULT_ADDR=https://vault.example.com:8200 VAULT_TOKEN=<root-or-admin-token> \
  node examples/jwt-auth/vault-jwt-demo.mjs
```

The app configures everything it needs (two `jwt` mounts, roles, a policy, a demo secret), runs the
scenarios, then removes all of it again. It needs a token allowed to manage `sys/auth`, `sys/policy`
and the demo secret — a dev-mode root token is the intended use.

## What it covers

**Positive**

| scenario | shows |
| --- | --- |
| literal `jwt` | the simplest wiring: a token you already have |
| `jwtPath` | token read from a file, re-read on every login |
| `jwtProvider` | token minted per login (the GitHub Actions / metadata-endpoint shape) |
| `role` omitted | falls back to the mount's `default_role` |
| custom mount | `vault auth enable -path=gha jwt` |
| one login, many reads | the client logs in once and reuses the Vault token |

**Negative**

| scenario | expected |
| --- | --- |
| wrong audience | `VaultHttpError` 400 |
| expired JWT | `VaultHttpError` 400 |
| signature from an untrusted key | `VaultHttpError` 400 |
| role that does not exist | `VaultHttpError` 400 |
| valid login, policy denies the path | `VaultHttpError` **403** — authentication succeeded, authorization did not |
| no JWT source / two sources / non-function `jwtProvider` | `InvalidArgumentsError` at construction |
| `jwtProvider` resolving a non-string | `InvalidArgumentsError`, no login attempted |
| `jwtProvider` that rejects | the provider's own error, unwrapped |

Every one of these arrives as a **rejected promise**, never a synchronous throw — so a single
`.catch()` on the call is enough, whichever way the login fails.

The 400-vs-403 distinction is the one worth internalising: **400 means Vault rejected the JWT**
(audience, expiry, signature, unknown role), **403 means the login worked and the resulting token
lacks a policy for that path**. They point at completely different fixes.

## Where the JWT comes from

The demo signs its own RS256 tokens with a throwaway key generated at startup, so it needs no
identity provider and no network beyond Vault itself. In production that key is your IdP: GitHub
Actions (`core.getIDToken()`), GitLab CI, a cloud metadata endpoint, or SPIFFE/SPIRE. Vault is told
which signatures to trust via `jwt_validation_pubkeys` (as here) or, more usually,
`oidc_discovery_url` pointed at the provider.
