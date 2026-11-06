# Unreleased

- **CI / release tooling (#229).** The publish job holds the npm trusted-publishing credential
  (`id-token: write`). It no longer fetches and runs tooling from outside the lockfile, and what
  it must fetch is kept away from that credential.
  - The job no longer runs `npm install -g npm@latest` (npm `latest` had moved to 12.x). It uses
    the npm bundled with Node 24 and fails if that is older than 11.5.1, which trusted publishing
    needs.
  - `npm ci --ignore-scripts` in the publish job. No locked package has an install script today;
    this keeps a future one from running there.
  - `test/verify-package.mjs` still installs the packed tarball's runtime dependencies from the
    registry, as a consumer would, but with `--ignore-scripts` and without the OIDC request,
    Actions runtime and npm/GitHub token variables, both for the install and for the checks that
    load the package.
  - `config` is locked as a devDependency (`^4.4.2`, inside the unchanged `>=1 <5` peer range)
    instead of `npm install config` in three CI jobs.
  - `test/workflows.test.mjs` fails if a workflow `run:` command fetches packages at run time
    (`npm install`/`add`/`update`/`exec`, `npx`, `yarn add`, `pnpm`, `@latest`), if a publish
    `npm ci` loses `--ignore-scripts`, if the npm check goes, or if verify-package stops
    scrubbing the environment.

  Library code and runtime dependencies are unchanged; the packed `package.json` now also lists
  `config` under `devDependencies`, which consumers do not install.

- **Tests: the e2e suites exit without `--exit` (#220).** Plain `mocha` on `e2e.test.mjs` or
  `e2e.kv2.test.mjs` hung after the summary. Two clients holding renewable tokens were never
  closed, so their renewal timers kept the event loop alive: the AppRole "with secret ID" test,
  and the KV path-validation suite shared by both files (a one-hour service token). The renewal
  tests named in the issue already closed theirs. Both now close their clients, and the
  `test:e2e*` scripts load `test/e2e/renewal-timer-guard.mjs`. If a renewal timer is still armed
  after the last test, it fails the run, naming the test or hook in which that client was first
  used, and cancels the timer so the run exits even without `--exit`. `--exit` stays in the
  scripts. Test-only; no library change.

- **A warning for a plain `http://` `api.url` off this machine (part of #202).** When `api.url` is
  `http://` and its host is not loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), the
  client now logs one `warn` line when it is created, because the token and secrets would cross the
  network unencrypted. It names only the host and port, is logged once per host per process, and
  changes nothing else: the client connects and works as before. With the default logger it goes to
  `console.warn`; `logger: false` silences it. README: "Plain `http://` api.url".

- **Security: redirects are followed only within the origin of `api.url` (#232).** Requests
  used `fetch()`'s `redirect: 'follow'`, which sends every header but `Authorization`, `Cookie`
  and `Proxy-Authorization` to whatever origin a `Location` names. `X-Vault-Token` went with it, a
  307 or 308 on a login replayed the credentials in its body, and the other origin's answer was
  returned as Vault data. Requests are now sent with `redirect: 'manual'`, and the client follows
  a redirect itself only to the same origin (scheme, host and port), as `fetch()` would: up to 20
  hops, method and body kept on a 307 or 308, a `GET` without a body on a 303 and on a 301 or 302
  after a `POST`. A redirect to another origin rejects with a `VaultError` before anything is
  sent there. That includes `https:` to `http:`, and `http:` to `https:` on the same host.
  - *Compatibility.* Same-origin redirects, such as Vault's own for a `//` in a path, behave as
    before. A test sends each redirect status with GET, POST, PUT, PATCH and DELETE both ways and
    compares the method, path, body and headers the server receives. Where `fetch()` gave up
    (more than 20 hops, a `Location` that does not parse, is not http(s) or carries
    credentials), the request still rejects with `TypeError: fetch failed`. Changed:
    - An `http://` `api.url` that a load balancer redirects to `https://` now fails. Use the
      `https://` URL.
    - A Vault HA standby answers with a 307 to the active node's `api_addr` when request
      forwarding fails. If that address is another origin, the request now fails instead of
      following it.
    - A `redirect` in `api.requestOptions` is passed to `fetch()` as it is; `'follow'` restores
      the old behaviour. `redirect: null`, which `fetch()` rejected on every request, now reads
      as not set.
    - `fetch()` now receives `redirect: 'manual'` instead of `'follow'`, with `api.timeout: 0`
      too. Code that stubs `fetch()` and checks its options will see this.
  - README: "Redirects and the Vault token" describes the policy and the opt-out.

- **Fixed: a token lookup without a usable `ttl` no longer yields a `NaN` expiry (#236).** Without
  `expire_time`, the expiry is `creation_time` (or `last_renewal_time`) plus `ttl`. A
  `lookup-self` answer where either was missing or not a number made that `NaN`, so
  `getExpiresAt()` returned `NaN` and the token counted as renewable. Such a token now has a
  `null` expiry, as one with `ttl: 0` and no `expire_time` already had, and is not renewable.
  - *Compatibility.* The token is still used until it is replaced: a `NaN` deadline never passed,
    and a `null` one means none. No timer is armed for it, as before. The log output is the same:
    the renewal timer still logs `token renewal stopped (accessor=…): token has no usable expiry;
    …` once, after a login or a renewal, when Vault marked the token renewable. A numeric-string
    `ttl` or `creation_time` is read as before. One more case changes: a numeric string too long
    to fit in a number used to give a deadline in the past, so every call logged in again. Real
    Vault always sends a numeric `ttl`, so this only affects proxies, mocks and test doubles.

- **Fixed: a token revoked on the Vault side is replaced on the next request (#235).** The client
  logged in again only once its own clock said the token had expired. After a server-side
  revocation, every request failed with `VaultHttpError` 403 until then, even when the auth backend
  could log in again at once. Now a 403 on a secret request (the KV methods, `request()`, and the
  `autoDetect` mount detection) is checked with `auth/token/lookup-self`. If Vault no longer accepts
  the token, the client drops it with its renewal timer, logs in again and sends the request once
  more.
  - *Compatibility.* A policy denial is returned as before and costs no login, so an AppRole
    `secret_id` with limited uses is not spent on it. It does cost one extra `lookup-self` request
    (with `autoDetect`, also for a mount the token may not see), which counts against a token with
    limited uses. Each request is sent again at most once, and one login serves every request
    rejected with the same token. When that attempt fails, the call rejects with its error (a
    failed login, a 404, a timeout) rather than the dead token's 403. A 403 on the login itself
    and any 403 under `token` auth are returned as before, without a lookup. Other statuses are
    untouched.
  - Revoking a client's token no longer locks it out: it logs straight back in. To cut a client
    off, also revoke or rotate its login credential.
  - README: "Tokens revoked on the Vault side".

# 3.1.0 Release notes (2026-11-05)

Upgrading from 3.0.x needs no code change. Two things behave differently; both are covered
below:

- Requests now time out after **120 s** by default (`api.timeout`). Raise it if your Vault allows
  longer requests, or set `api.timeout: 0` for the 3.0.x behaviour. An `api.timeout` key already
  in your config, ignored until now, takes effect in milliseconds.
- `VaultClient.boot()` warns once when a later call for the same name passes a different logger,
  dispatcher or function, which it ignores. Boot each name once and use `VaultClient.get()`.

Changes in this release:

- **Added: a default request timeout, `api.timeout` (#223).** Every request to Vault, including
  logins, `lookup-self` and background `renew-self`, now has to finish within `api.timeout`
  milliseconds, **120 000 by default**. The limit covers response headers, body and redirects. A
  request that runs out of time rejects with the new `RequestTimeoutError` (a `VaultError`;
  `timeout` holds the limit and `cause` the `fetch()` rejection). With `api.kv.autoDetect`, a mount
  detection that times out fails the call with the usual `VaultError` ("Failed to detect KV engine
  version…"), with `RequestTimeoutError` on its `cause`. A timed-out renewal is retried like any
  other failed one. Before, nothing in the client bounded a request: Node's default dispatcher
  gave up after 300 s without response headers, and a body that kept trickling in was never cut
  off.
  - *Compatibility.* The default is above Vault's own default `max_request_duration` (90 s), so a
    request that a Vault with default settings would still answer is not cut short. Responses and
    the other errors are unchanged. If your Vault allows longer requests, raise `api.timeout`;
    `api.timeout: 0` turns the limit off and sends exactly the `fetch()` options 3.0.2 sent.
  - *An `api.timeout` key that 3.0.x ignored is now honoured, in milliseconds.* `null` means "not
    set" (the default). Anything other than an integer from 0 to 2147483647 raises
    `InvalidArgumentsError` at construction, including a numeric string such as `'30000'` from an
    environment variable (use node-config's `__format: 'number'`). A value under 1000 logs a
    warning, since `timeout: 30` meant as seconds now fails every request after 30 ms.
  - *What `fetch()` receives.* With a limit in force, every request carries the client's own
    `signal`. A `signal` in `api.requestOptions` (an `AbortSignal` or a signal-like polyfill) is
    not passed on directly; it still aborts requests with its own reason, through a listener the
    client removes when each request settles, and its listener limit is raised to 1500 as
    `fetch()` did. Code that wraps or stubs `fetch` and checks the signal will see the difference.
    The deadline is a timer cleared when the request settles, so none outlives a fast request.
  - README: "Request timeouts" no longer says there is no default timeout, and describes the
    300 s dispatcher timeouts that apply with `timeout: 0`.

- **Fixed: `VaultClient.boot()` notices a different logger, dispatcher or other function
  (#224).** 3.0.2 compared only `jwtProvider` and `distributedClaimAccessTokenProvider` by
  identity. Every other function was the same constant, and class instances were compared by
  their own enumerable keys, which for an undici `dispatcher` say nothing about its proxy or TLS
  settings. Re-booting a name with a different logger, dispatcher or function therefore returned
  the existing instance without the "different options" warning, and the new value was silently
  ignored. Now every function and every object that is not plain data compares by identity, a
  `Buffer`, `Date`, `URL` or `RegExp` by value, and plain objects and arrays (from any realm) by
  content as before. No option getter, `toJSON()` or Proxy trap takes part in the comparison, and
  a `BigInt` option no longer makes `boot()` throw.
  - *The warning names the options that differ* (`Differing options: logger.`) and is logged once
    per instance for each set of them, instead of on every call.
  - *Compatibility.* `boot()` still returns the existing instance and ignores the new options; only
    the warning changes. This reverses the 3.0.2 note that "re-booting with freshly created ones
    stays silent": a logger class instance, a dispatcher, or a logger object built from new
    functions, re-created for each `boot()` call, now logs the warning once, because it is ignored
    too. So does an equal `Map`, `Set` or typed array (other than a `Buffer`) re-created per call.
    A plain-object logger that reuses the same functions stays silent. Boot each name once and use
    `VaultClient.get(name)` elsewhere.

- **Security (development dependencies only): raise `minimatch` to `^11.0.4`
  (GHSA-g3hv-75wg-m249).** eslint, mocha and c8 pulled `minimatch@10.2.6`, whose pattern
  preprocessing can be made to grow without bound (denial of service). Only the 11.x line is
  fixed. A new `minimatch` override raises it, and the `glob` override moves from `^13.0.0` to
  `^14.0.3`, the release built for minimatch 11: glob 13 relies on minimatch 10 internals that 11
  removed. Lint, test discovery (776 tests in 26 files) and coverage (16 files) are unchanged.
  Nothing here ships to consumers: the package has no runtime dependency on either.
- **Tests: generic-backend e2e suite (#222).** `npm run test:e2e:generic` runs against a real
  Vault what was only mock-tested: a transit round-trip through `request()`, which never sends a
  detection request even with `autoDetect: true`; a transit mount under `autoDetect`, detected as
  passthrough (no `data/` segment, no `{ data }` envelope, KV v2 helpers throw
  `UnsupportedOperationError` without reaching it); exactly one detection request on the wire for
  six first reads of a fresh KV v2 mount, five of them started while that request is still waiting
  for its answer; `Lease.getMetadata()` on a live read; and detection with a token that can only
  `read` one key and gets 403 from `sys/mounts`. It runs in the `e2e` CI job on every Node × Vault
  leg. Test-only; no library change.
- **Dependencies:** lockfile refresh within the existing ranges: `@aws-sdk/credential-providers`
  3.1161.0 (#219) and development tooling (#218). No `package.json` range changed.

# 3.0.2 Release notes (2026-11-03)

- **Fixed: background renewal no longer stops for tokens that have not reached a maximum TTL.**
  3.0.1 inferred "maximum TTL reached" from wall-clock arithmetic: whether the absolute expiry
  moved by about the time spent waiting, within one second, and whether the whole-second `ttl`
  went down. On real Vault this stopped renewal for uncapped tokens in two cases. After that, every
  call failed once the token expired: `token` auth with `AuthTokenExpiredError`, and other backends
  re-authenticated.
  - *Renewals under a second apart* (period × `renewalFraction` < 1 s). Examples: a period-2 token
    at 0.4, a period-3 token at 0.3, a period-10 token at 0.05. `lookup-self` truncates `ttl`, so it
    flips between neighbouring whole seconds. On Vault 2.2, most clients tested stopped within a
    few renewals.
  - *A `renewalIncrement` equal to the remaining lifetime*, for example a 20 s token renewed at 10 s
    with `renewalIncrement: 10`. The deadline stays put, and the token died at its original
    expiry.

  The client now reads Vault's own signal. A capped `renew-self` carries a warning (`TTL of "…"
  exceeded the effective max_ttl of "…"; TTL value is capped accordingly`), and an uncapped one
  never does; this was measured on Vault 1.21 and 2.2 for explicit max TTLs, AppRole
  `token_max_ttl` and the mount's max lease TTL. Renewal stops on that warning and continues
  otherwise. Vault's `period of "…" exceeded the effective max_ttl of "…"; period value is capped
  accordingly` warning is deliberately not a stop signal: it comes with every renewal of a periodic
  token whose period is above the role's `token_max_ttl` or the mount's max lease TTL, and that
  token stays renewable at the shorter period. The stop is logged as
  `Vault capped the renewal at the token's maximum TTL`, replacing
  `Vault did not extend the token (maximum TTL likely reached)`. A capped token stops at its
  first capped renewal. 3.0.1 sometimes made one more renewal first, when the cap still moved the
  deadline by more than a second (a 1 h token capped at 1 h 20 m, for example).
- **Fixed: a failure after a successful renewal no longer re-arms against the old token.** Such a
  failure (a logger that throws, or a duck-typed token whose expiry `Date` cannot represent) used
  to be handled as a failed renewal. That scheduled another renewal of a token the client had
  already replaced. Now it is logged as `token renewal bookkeeping failed`, the renewed token stays
  in use, and no unhandled rejection is raised. The "renewal stopped" warning also no longer throws
  a `RangeError` (which could reject a successful login) for an out-of-range expiry.
- **Changed: debug logging.** The debug line `setting refresh timer for token (accessor=…)` was
  logged before the client knew whether it would arm a timer. It is replaced by
  `renewal timer armed (accessor=…); renewing in <delay>`, logged only when a timer is actually
  armed; that line also replaces `sleeping for <delay>`.
- **Docs (renewal):**
  - The README's maximum-TTL section describes the actual stop rule.
  - It notes that a 1-second period is too short, because lookup reports `ttl: 0` right after each
    renewal.
  - The `renewalFraction` notes now state that low fractions on short TTLs are safe.
  - The `renewalIncrement` notes now state that, on a non-periodic token, the increment replaces
    the remaining lifetime (a smaller value shortens the token, and `1` is treated as expired after
    the first renewal), and that periodic tokens ignore it.
- **Fixed: a literal `distributedClaimAccessToken` is validated at construction.** An empty,
  whitespace-only or non-string value (`''` from `process.env.GRAPH_TOKEN || ''`, `null`, a number)
  used to be sent to Vault as-is, so the login failed later at Vault's group-fetch step with an error
  that did not mention the option. It now raises `InvalidArgumentsError`. `undefined` still means
  "not sent". Surrounding whitespace is trimmed from the literal and from the provider's value, and
  a provider resolving a whitespace-only string is rejected like an empty one.
- **Changed: the JWT and the distributed claim access token are acquired concurrently.** With
  `jwtProvider` and `distributedClaimAccessTokenProvider` both set, the two run at the same time,
  not one after the other. Login latency is the slower of the two rather than their sum, and the JWT
  is no longer minted early and left to age while the Graph token is fetched. As a result, the
  access token provider is now also called when the JWT source fails. A failed JWT source still
  rejects the login at once with its own error, as in 3.0.0, without waiting for the access token
  provider; that provider is not cancelled, and a failure it reports later is still logged. A failed
  access token waits for the JWT source, so when both fail the JWT source's error is the one raised,
  whichever failed first.
- **Changed: a failing credential provider is named in the log.** When `jwtProvider` or
  `distributedClaimAccessTokenProvider` throws or rejects, the client logs
  `JWT login aborted: "<option>" failed: <message>` at error level. The login still rejects with the
  provider's own error object, unchanged. The JWT login info line now always ends with
  `distributed claim access token: literal|provider|none`, so a token that is missing because its
  variable was unset shows up in the log.
- **Fixed: `VaultClient.boot()` notices a changed provider function.** The options fingerprint
  rendered every function as the same constant. Re-booting a name with a different `jwtProvider` or
  `distributedClaimAccessTokenProvider` therefore did not log the "different options" warning, and
  the new function was silently ignored. Those two provider keys are now compared by identity, as
  the code comment already claimed. Every other function (logger methods, an IAM `credentials`
  provider chain) still compares equal, so re-booting with freshly created ones stays silent.
- **Types: `distributedClaimAccessToken` and `distributedClaimAccessTokenProvider` accept
  `undefined`.** Under `strict`, `{ jwt, distributedClaimAccessToken: maybe }` with
  `maybe: string | undefined` failed with TS2322. Setting both keys is still a type error.
- **Hardening: the literal `jwt` and `distributedClaimAccessToken` are kept in private class
  fields.** `console.log`, `util.inspect` and `JSON.stringify` of the auth object no longer show
  either credential.
- **Docs:** the JWT example no longer wires `distributedClaimAccessToken` to an environment
  variable. The renewal table now says that `jwtPath`/`jwtProvider` combined with a *literal*
  `distributedClaimAccessToken` replays an expired Graph token on re-login. "Redirects and the
  Vault token" now says a 307/308 also replays the login body and its credentials. The JSDoc no
  longer calls `fetch_groups` a role setting.

# 3.0.1 Release notes (2026-11-02)

- **Fixed (#201): a renewable token that reaches its maximum TTL is no longer reused after Vault
  expires it.** `lookup-self` can return `ttl: 0` alongside `expire_time`; the client previously
  treated that token as non-expiring, stopped renewing it, and continued sending the expired token.
  The client now treats `ttl: 0` as expired on receipt, uses Vault's absolute `expire_time` for
  positive TTLs, and stops background renewal when the expiry no longer advances materially.
  The scheduler compares Vault's whole-second TTL with the time since renewal, so short-period
  tokens continue renewing even when each expiry advance is one second or less. When renewal stops,
  it logs the accessor and reason without logging the token ID. On the next call after the
  client-side expiry deadline, backends that can obtain fresh credentials re-authenticate; `token`
  auth raises `AuthTokenExpiredError`, and a spent AppRole `secret_id` or expired literal JWT can
  make later login attempts fail.

# 3.0.0 Release notes (2026-10-29)

Upgrading from 2.x: [MIGRATION.md](MIGRATION.md) lists what can need a change and what to check.

- **BREAKING: Node.js 18 support is dropped, as announced in 2.3.0.** `engines.node` is now
  `>= 20.19.0`. Node 18 reached end-of-life on 2025-04-30 and no longer receives security patches
  from the Node.js project; the runtime deprecation warning added in 2.3.0
  (`checkNodeVersion.js` / `NodeVaultClientNode18Deprecation`) is removed along with it, since it
  has served its purpose. CI drops the Node 18 legs from the `test` and `e2e` matrices and moves
  the single-Node-version jobs (`audit`, `lint`, `coverage`, `package`, `e2e-kv2`) from Node 20 to
  Node 22; `.nvmrc` now pins 22.

- **Security (GHSA-2vr8-g4vw-7xpm): non-2xx Vault response bodies are no longer written to the
  logger.** The failure log of every operation (`read`, `list`, `write`, `delete`, `update`,
  `request`, `deleteVersions`, `undeleteVersions`, `destroyVersions`, `readMetadata`,
  `deleteMetadata`), the mount-detection error message and the token-renewal failure logs used to
  include the raw response body, at `error` level and on `console.error` by default. Some non-2xx
  bodies carry secret material: a transit batch decrypt with one bad item answers HTTP 400 with
  the other items' plaintexts in `data.batch_results`. These lines now carry only the HTTP status
  and Vault's `errors` strings (`403 - {"errors":["permission denied"]}`), or
  `<status> - (response body omitted)` when the body has no `errors` array.

  The thrown `VaultHttpError` is unchanged: `message` is still `"<status> - <raw body text>"` and
  `error` still holds the parsed body. If your logs are less protected than your Vault secrets, do
  not log a caught `VaultHttpError` as is; log `err.statusCode` and `err.error?.errors` instead.
  A mount-detection `VaultError` now exposes the original HTTP error as `err.cause`.

- **Security (GHSA-rr65-m54w-rfr9): the KV methods reject paths that `fetch()` or Vault would
  resolve to a different key.** `read`, `list`, `write`, `delete`, `update` and the KV v2 helpers
  put the caller's path into the URL unchecked, so a path built from user input
  (`secret/tenants/${id}/key` with `id` set to `..`, `%2e%2e`, `..%2f`, `..\` or an empty string)
  could send the client's token to another tenant, another mount or `sys/*`. They now reject such
  a path with `InvalidArgumentsError` before any request: `?`, `#`, `\`, control characters,
  unpaired surrogates or a trailing space; an empty, `.` or `..` segment, also percent-encoded; a
  percent-encoded mount; and a trailing slash on the KV v2 helpers. The message names the rule,
  not the path. See "Path validation" in the README. `request()` still sends its path literally.

  Behaviour changes: `read('secret/foo?version=N')` now throws, so use
  `request('GET', 'secret/data/foo?version=N')`; paths with `\` separators or an empty segment
  (`secret//foo`) throw; a non-string path throws instead of being stringified. On KV v2 a
  leading slash now addresses the key it names: `/secret/foo` used to reach `secret/secret/foo`.

- **Security (GHSA-wf8v-q2h3-hgjm): KV mount detection no longer caches unvalidated responses,
  and KV paths with encoded dots, separators or percent signs are rejected.** With
  `api.kv.autoDetect`, the first detection for a mount cached any response that had a `data`
  object, falling back to the first path segment and to KV v1 when `path` or `type` was missing.
  A caller path with dot segments or encoded separators could point that detection request at
  another Vault endpoint, and the cached result then misrouted every later KV call on the mount
  for every caller of the client.
  - Detection now requires a string `data.path` and `data.type`, and caches nothing otherwise. A
    well-formed answer is cached only when its mount contains the requested path; when it does
    not, that caller gets `InvalidArgumentsError` and callers sharing the detection are
    unaffected. Auth mounts are keyed as `auth/<mount>`, which also fixes an auth mount
    overwriting the cache entry of a KV mount with the same name, and a mount in a child
    namespace is keyed relative to `api.namespace`.
  - A percent-encoded segment of a multi-segment mount (`team/k%76/config` for `team/kv`) is
    rejected in `engines` mode as well. It used to miss the override and go out unrewritten, and
    Vault decoded it onto the mount's own endpoints.
  - On top of the GHSA-rr65-m54w-rfr9 checks, the KV methods reject `%2e`, `%2f`, `%5c` and
    `%25` in any case. Vault decodes encoded separators and redirects to the cleaned path, and
    Vault 2.x does so again on every redirect hop, so a single decode is not enough and encoded
    forms are rejected rather than decoded. `request()` is unchanged.
  - **Behaviour change:** a KV method path that legitimately contains one of these escapes, such
    as a key name passed through `encodeURIComponent()` that contains a `/`, must now go through
    `request()`.

- **Security (GHSA-x5xf-r8x2-647h): AppRole login no longer logs the `role_id`.** Every login and
  re-login logged `making authentication request: role_id=<role id>` at `info` level, which the
  default logger writes to `console.info`. For a role with `bind_secret_id=false` the `role_id` is
  the whole login credential. The line now names the auth mount
  (`making authentication request: approle mount=<mount>`); the login request is unchanged, and
  neither `role_id` nor `secret_id` reaches any log level. On 2.3.0 and earlier, pass
  `logger: false` or a logger that discards `info`.

- **Fixed: slash trimming no longer uses regular expressions with quadratic backtracking**
  (CodeQL `js/polynomial-redos`). `api.namespace`, `api.engines` keys, mount paths from detection
  responses and URL segments were trimmed with `/\/+$/`, which took over three seconds on a
  value with a run of 100,000 slashes that does not end the string. They now go through a linear
  scan (`src/slashes.js`); the result is the same.

- **Added Node.js 26 (the current release line, on track to become the next LTS on 2026-10-28)
  to the `test` and `e2e` CI matrices.**

  Also flagging, not acting on: **Node 20 itself reached its own documented end-of-life on
  2026-04-30** (github.com/nodejs/Release schedule.json) — the same category of problem this
  release fixes for Node 18. `engines.node >= 20.19.0` keeps the commitment 2.3.0 already
  published, but does not by itself get consumers off an unsupported runtime; whether to raise
  the floor further (e.g. to Node 22, the oldest line still in Maintenance LTS) is a maintainer
  call the previous release didn't anticipate needing this soon, not something folded into this
  PR unasked.

- **Added HashiCorp Vault 2.1.x to CI.** `e2e` gains a `{node: 22, vault: '2.1'}` leg alongside
  the existing `2.0` one (both Vault 2.x lines now on one Node version, matching the existing
  convention for the 2.x axis); `e2e-kv2` now runs against all three supported lines
  (`1.21`, `2.0`, `2.1`). `docker-compose.yml`'s reproduce-locally comment gained the matching
  `VAULT_IMAGE=hashicorp/vault:2.1` example.

- **Added HashiCorp Vault 2.2.x to CI.** `e2e` gains a `{node: 22, vault: '2.2'}` leg next to the
  `2.0` and `2.1` ones, and `e2e-kv2` now runs against all four supported lines (`1.21`, `2.0`,
  `2.1`, `2.2`). The reproduce-locally examples in `docker-compose.yml` and `CONTRIBUTING.md` now
  point at `2.2` as the latest 2.x line.

- **Dependency updates, unblocked by dropping Node 18** (previously held back in
  `.github/dependabot.yml` purely because their majors require Node >= 20):
  `mocha` 11.7.6 → 12.0.0, `eslint` 9.39.5 → 10.10.0, `@eslint/js` 9.39.5 → 10.0.1,
  `c8` 10.1.3 → 12.0.0. Also `@aws-sdk/credential-providers` 3.1100.0 → 3.1130.0 (a routine
  in-range bump). All devDependencies/tooling; nothing here ships to consumers.

- **`peerDependencies.config` widened from `>=1 <4` to `>=1 <5`** (admits config 4.x; config 5.x
  is still excluded — see below). This surfaced a real, undocumented breaking change in config
  4.x: `config.util.initParam`, which `VaultNodeConfig`'s `NODE_CONFIG_DIR` resolution depended
  on, was silently removed from the public API (`config.util` is now a `ConfigUtils` instance
  with no such method — config's own 4.0.0 release notes list three breaking changes and this
  isn't one of them). Fixed by replicating `initParam`'s exact historical behavior
  (`--NODE_CONFIG_DIR=value` command-line argument, then the environment variable, then the
  default) directly in `VaultNodeConfig.resolveConfigDir`, which no longer touches `config.util`
  at all — verified against config 1.31.0, 3.3.12 and 4.4.2. config 5.x remains ignored in
  `dependabot.yml`: it is a ground-up ESM rewrite ("node-config is now an ESM module" per its own
  release notes), which this CommonJS codebase's synchronous `require('config')` cannot adopt
  without its own dedicated compatibility work — raising that cap needs its own PR, not a
  bundled guess.

- Security: raise the `brace-expansion` override from `^5.0.9` to `^5.0.12` (lock 5.0.9 → 5.0.12).
  Clears GHSA-6j4f-fj2g-mc7p and GHSA-qhr7-859c-m2p7 (high, stack exhaustion from uncontrolled
  recursion) and GHSA-q2hr-2g5m-vwhr (quadratic-time `{a},b}` rewrite), all published 2026-09-29
  and fixed by 5.0.12. Dev/transitive only (eslint → minimatch); no runtime dependency or behavior
  change.

# 2.3.0 Release notes (2026-09-11)

- **This is the last release of node-vault-client to support Node.js 18.** Node 18 reached
  end-of-life on 2025-04-30 and no longer receives security patches from the Node.js project,
  independent of anything pinned in this package's own dependency tree — which is itself feeling
  the pressure: `c8`, `eslint`, `@eslint/js`, `config` and now `mocha` all have majors held back
  in `.github/dependabot.yml` purely because they drop Node 18. Requiring the client now emits a
  one-time `process.emitWarning` (code `NodeVaultClientNode18Deprecation`) when running under
  Node 18, so consumers who never read a changelog still see it. The next major release raises
  `engines.node` to `>= 20.19.0`, drops the Node 18 CI matrix legs, and clears the accumulated
  ignore-list entries so those dependencies resume normal updates. No other behaviour changes;
  this is purely a deprecation notice ahead of that release.

- Added optional `distributedClaimAccessToken` and `distributedClaimAccessTokenProvider` keys to
  the `jwt` backend's `config` (#175), which supply Vault's optional
  `distributed_claim_access_token` login parameter. It matters only for Microsoft Entra ID (Azure
  AD): past 200 groups Azure stops putting group membership in the token and sends OIDC distributed
  claims instead — `_claim_names`/`_claim_sources` pointing at the Microsoft Graph API — and a mount
  whose `provider_config` sets `fetch_groups` skips the claim unconditionally and always asks Graph.
  Either way Vault has to call Graph itself, and the JWT being logged in with is not a credential
  for that call, so without this parameter such a login fails at the group-fetch step — after the
  JWT has already validated, so the failure names the group lookup rather than the token, which was
  fine. `distributedClaimAccessToken` takes a literal Graph access token; it is fixed at
  construction and re-sent on every re-login, so it inherits the literal-`jwt` staleness caveat —
  more sharply, since an Entra access token lasts about an hour.
  `distributedClaimAccessTokenProvider` takes an (optionally async) function invoked fresh at login
  time — never at construction, never cached — exactly mirroring `jwtProvider`, and is the option
  for anything longer-lived than the Graph token. Providing both raises `InvalidArgumentsError` at
  construction, as does a non-function provider; a provider resolving to a non-string or empty
  string raises it at login, without a request being sent. Purely additive: both keys are optional and
  absent by default, and with neither set the login request body is byte-for-byte what it was
  before, so no existing configuration changes behaviour. The README's JWT section gains a
  subsection on when this is needed, and records that `fetch_groups` is a `provider_config` option
  on the auth mount's config rather than on the role, while `groups_claim` — without which Vault
  resolves no groups and ignores any Graph token passed — is on the role.

- Documented the `bound_audiences` requirement for JWT auth, which is the most common reason a
  first login fails and was previously absent from the README. Vault requires a `jwt` role to bind
  the audience the token carries, but does not catch the omission when the role is created: as long
  as the role has some other bound constraint it is accepted, and the failure only appears at login
  as `audience claim found in JWT but no audiences bound to the role`. The JWT section now gives
  that error verbatim, the wrong-audience variant, and a `vault write .../role/...` example that
  binds the audience. The GitHub Actions section additionally spells out that
  `core.getIDToken('vault')` mints `aud: vault`, so the role must bind `vault` — following that
  snippet without it was a guaranteed failed login. Also recorded that Vault does not require an
  `exp` claim, so a `jwtProvider` that omits one produces a credential that never expires. Every
  quoted error string was taken from a live Vault and is identical on 1.21 and 2.0. No code change.

# 2.2.0 Release notes (2026-09-01)

- Documented three things about the HTTP transport that were true but unwritten, and scoped the
  `version` npm hook. No runtime change. `api.requestOptions` now carries a note that the `undici`
  you install has to be interface-compatible with the one Node bundles: on Node 24 a dispatcher
  from `undici@8` is rejected by the global `fetch()` with `cause.code` of
  `invalid onRequestStart method` before the request leaves the process, so the proxy and
  self-signed-CA recipes need `undici@^7`. A new "Request timeouts" section records that there is
  no default timeout — a Vault that accepts the connection and never answers leaves calls pending
  indefinitely — and gives the dispatcher-based fix, plus why a single
  `signal: AbortSignal.timeout(ms)` in `requestOptions` is the wrong tool: it is shared by every
  request, so it works once and then aborts the rest. A new "Redirects and the Vault token"
  section records that requests follow redirects (Vault HA answers standbys with a 307 to the
  active node) and that Node's `fetch()` forwards `X-Vault-Token` across a cross-origin redirect,
  since it strips only `Authorization`, `Cookie` and `Proxy-Authorization` — so `api.url`, its DNS
  and any load balancer in front of it are trusted infrastructure. Finally, the `version` hook was
  `git add -A .`, which swept any unrelated working-tree change into the release commit; it now
  stages only `CHANGELOG.md`, `package.json` and `package-lock.json`.

- `VaultClient.boot()` now logs a warning when it is called for a name that already exists with
  options that differ from the ones the instance was booted with (#146). The options were, and
  still are, ignored in that case — the memoized instance is returned unchanged — so this only
  makes a silent mismatch visible. Silent when the options match (compared order-insensitively,
  as a hash, so no credential is retained for the comparison) and when `logger: false`.

- Fixed renewal callbacks acting on state they no longer own (#145). A renewal request still in
  flight when its token was replaced, or when `close()` / `cancelTokenRefresh()` was called, would
  apply its result anyway: overwriting the newer token, clearing the newer token's timer and then
  bailing on its own expired one (leaving a live token permanently un-renewed), or re-arming a
  timer after the client had been closed. Superseded callbacks are now discarded. Renewal that is
  not superseded behaves exactly as before.

- Added `auth.renewal: false`, which disables the background
  token-renewal timer (#17). The client then uses the token until it expires and re-authenticates
  on the next call instead of renewing it in the background. Useful for short-lived processes —
  the renewal timer keeps the Node.js event loop alive, so without it a finished script does not
  exit unless you call `close()` — and wherever re-login is preferable to extending a lease.
  Default behaviour is unchanged. Note this is only a no-op for backends that can obtain a fresh
  credential on their own (`kubernetes`, `iam`, `jwt` via `jwtPath`/`jwtProvider`): `token` auth
  cannot re-authenticate at all and will raise `AuthTokenExpiredError` once the token expires, and
  `appRole`/literal-`jwt` replay the same credential. Expiring a token also revokes the leases it
  created, which matters if you read dynamic secrets.

- Added `auth.renewalFraction` and `auth.renewalIncrement`, for tuning renewal rather than
  turning it off (#17). `renewalFraction` (default `0.5`, range `(0, 1)`) sets how much of
  the token's remaining lifetime to wait before renewing; a lower value renews earlier and leaves
  room for more retries, which shrink geometrically as the lifetime does. `renewalIncrement` (unset by default)
  is sent as `increment` to `auth/token/renew-self` to request a specific extra TTL, which Vault
  caps at the token's max TTL. Both are validated at construction and raise
  `InvalidArgumentsError` on bad input. Defaults reproduce the previous behaviour exactly: the
  halfway point, and a renew request with a `null` body. All three keys live on `auth`, not in
  `auth.config`, so they cannot collide with a key an existing caller already passes to a backend;
  no constructor signature changed either, so anything subclassing `VaultBaseAuth` is unaffected.

- Added first-party TypeScript declarations (`index.d.ts`), referenced by the `types` field and
  included in the published `files` (#159). The package previously shipped none, leaving
  TypeScript consumers on the third-party `@types/node-vault-client`, which stops at the 1.x API:
  it has no `jwt` backend, no `close()`, no `delete()`/`update()`/`request()`, none of the KV v2
  version or metadata methods, none of the `api.namespace`/`api.kv`/`api.engines`/
  `api.requestOptions` or renewal options, and it declares `AuthToken`, `Lease` and the other
  sibling classes as runtime exports of the entry point even though it exports only the
  `VaultClient` class — so `new VaultClient.Lease(...)` type-checked and then threw. `auth` is
  typed as a discriminated union on `type`, and the three mutually-exclusive JWT sources are
  enforced at compile time. Types that appear in signatures are exposed in type space under the
  `VaultClient` namespace. Declarations are verified by `npm run test:types` in CI, which
  compiles positive usage together with `@ts-expect-error` cases so a wrong signature fails the
  build. `src/errors.d.ts` covers the error classes, which the README documents as
  `node-vault-client/src/errors` because the entry point does not export them; that import
  previously raised `TS7016` under `strict`, so the documented path was the one TypeScript
  rejected. The declarations are deliberately permissive wherever the runtime tolerates more than
  the JSDoc suggests, so that no usage which compiled against the third-party types and works at
  runtime is newly rejected: a partial `logger` object is accepted (missing methods fall back to
  `console`, as before), and the methods returning a Vault response body stay assignable to
  `Promise<void>`. Runtime behaviour is unchanged; no file under `src/` was touched. If you have
  `@types/node-vault-client` installed, uninstall it.

- Added a JWT auth backend (`auth.type: 'jwt'`, default mount `"jwt"`) for workload identity
  federation — GitHub Actions, other CI systems, GCP/Azure/SPIFFE workloads — against Vault's
  [JWT auth method](https://developer.hashicorp.com/vault/docs/auth/jwt). Models
  `VaultKubernetesAuth`. `config.role` is optional, matching Vault's `default_role` fallback.
  Exactly one of three mutually-exclusive sources supplies the JWT: a literal `config.jwt`
  string (CI jobs / processes shorter-lived than the token — a re-login resends that same
  string, so it fails once the IdP-issued token itself expires); `config.jwtPath`, a file
  re-read on every login (rotated projected tokens); or `config.jwtProvider`, an (optionally
  async) function invoked fresh at login time — never at construction, never cached — for
  tokens minted per login such as GitHub Actions' `core.getIDToken()` or a cloud metadata
  endpoint. A `jwtProvider` resolving a non-string/empty string, or a non-function
  `jwtProvider`, fails fast with `InvalidArgumentsError` without sending a login request. Only
  the non-interactive `jwt` flow is implemented; the browser-redirect `oidc` flow is out of
  scope for this service client. See the README's "JWT auth" section.

- Documented how to import the error classes (#161). The README named
  `UnsupportedOperationError` in eight places and `VaultError` in the error table, but nothing in
  the repository showed a consumer how to obtain either: the only `require` of the errors module
  was the example app's in-tree relative path. The `Error classes` section now gives the
  `node-vault-client/src/errors` import with a worked `instanceof` example, and the table lists
  all six exported classes with what raises each; it previously listed two. Two tests guard it:
  one fails if `files` would stop publishing `src/errors.js`, and one fails if a class is exported
  but missing from the README table. No runtime change, and no `exports` field was added, so every
  existing deep import keeps working.

# 2.1.2 Release notes (2026-08-03)

- Internal refactor: `VaultBaseAuth` no longer overloads a single `__authToken` field with two
  types. The in-flight login now lives in `__pendingLogin` (`Promise<AuthToken>|null`) and the
  resolved token in `__authToken` (`AuthToken|null`), so `getAuthToken()` reads the auth state
  directly instead of discriminating with `instanceof` at each use site. No behavior change —
  the single-flight login (concurrent callers share one login) and the renewal-timer wiring are
  unchanged, and both are now pinned by tests. Closes #120.

# 2.1.1 Release notes (2026-07-31)

- Dependencies bumped, with **zero known vulnerabilities and Node 18 still working**. The selection
  rule is deliberately "newest version that still *runs* on Node 18", not "newest version whose
  `engines` field mentions Node 18" — for most packages the `engines` bump to Node 20 is policy
  rather than a technical requirement, and capping on the declaration alone would force downgrades
  below patched releases. `npm audit` reports 0 vulnerabilities, as it did on 2.1.0; note that
  capping purely on `engines` declarations was tried first and produced 26 advisories (1 critical,
  7 high, 18 moderate), because every patched release of `@aws-sdk/credential-providers`,
  `serialize-javascript` and `brace-expansion` requires Node 20+. That approach is preserved in the
  branch history for auditability.
  - Bumped to latest: `@aws-sdk/credential-providers` → `^3.1100.0`, `aws4` `^1.8.0` → `^1.13.2`,
    `chai` → `^6.2.2`, `globals` → `^17.8.0`, `lodash` → `^4.18.1`, `sinon` → `^22.1.0`,
    `sinon-chai` → `^4.0.1`, `eslint`/`@eslint/js` → `^9.39.5`. Security overrides stay on their
    patched releases: `serialize-javascript` `^7.0.7`, `brace-expansion` `^5.0.9`.
  - Held below latest, because these genuinely break on Node 18 rather than merely declaring
    against it: `c8` stays `^10.1.3` (11+ requires Node `20 || >=22`; 12 pulls an ESM-only `yargs`
    and dies with `ERR_REQUIRE_ESM` on Node 18 — as a side effect `npm run coverage` now works on
    Node 18, which it did not on 2.1.0), `eslint` stays on 9.x (10.x declares
    `^20.19.0 || ^22.13.0 || >=24`), and the `config` peer range stays `<4` (config 4 requires
    Node `>=20`).
  - `npm ci` on Node 18 prints 19 `EBADENGINE` warnings — 16 AWS SDK/smithy packages plus
    `brace-expansion@5.0.9`, `lru-cache@11.5.2` and `serialize-javascript@7.0.7`. Each was
    executed on Node 18 to confirm the warnings are cosmetic: the AWS SDK resolves a provider
    chain and signs a request, and `brace-expansion`, `lru-cache`, `glob` and `minimatch` all
    behave correctly.
  - Verified on Node 18.20.8 / 20.20.2 / 22.23.2 / 24.18.1, each against a **fresh Vault 1.13.3
    instance in Docker**: `npm ci`, 306 unit tests, `lint`, the c8 threshold gate, and both e2e
    suites (`test:e2e` 6 passing/1 pending, `test:e2e:kv2` 10 passing) pass on all four.

- Two known limitations on Node 18, both pre-existing on 2.1.0 and neither hit by any npm script
  or CI job. Documented here so they are not rediscovered as mysteries:
  - `mocha --parallel` does not work on Node 18. `serialize-javascript@7.x` calls
    `crypto.getRandomValues` on the global at module load, and Node 18 has no unflagged global
    `crypto`, so mocha's parallel worker (`lib/nodejs/worker.js`) throws `ReferenceError: crypto is
    not defined` — surfaced unhelpfully as `✖ ERROR: null`. None of the `test*` scripts use
    `--parallel`; serial runs never load that module. Downgrading the override to `^6.0.2` restores
    parallel mode on Node 18 but reinstates a high advisory (GHSA-5c6j-r48x-rmvq RCE via
    `RegExp.flags`, GHSA-qj8w-gfj5-8c6v CPU-exhaustion DoS), so the patched version is kept.
  - Brace glob patterns (`*.{js,mjs}`) throw `TypeError: expand is not a function` under the
    `brace-expansion` override. v5 changed the export from a default function to a named
    `{ expand }`, and the blanket override applies it to `minimatch@3.1.5` (via `eslint`, wants
    `^1.1.7`) and `minimatch@9.0.9` (via `mocha`, wants `^2.0.2`), which still call it as a
    function. Brace-free patterns are unaffected, and neither `eslint.config.js` nor any test glob
    uses braces. Scoping the override per-major is not a way out: the backported `1.1.16`/`2.1.2`
    releases clear GHSA-3jxr-9vmj-r5cp but are still flagged high by GHSA-mh99-v99m-4gvg
    (unbounded-expansion OOM), which is only fixed in 5.0.8+.

# 2.1.0 Release notes (2026-07-28)

- Security: pin patched transitive tooling via `overrides` — `brace-expansion` to `^5.0.8`
  (clears GHSA-3jxr-9vmj-r5cp, Dependabot #60, and GHSA-mh99-v99m-4gvg) and `js-yaml` to `^4.3.0`
  (clears the concurrent quadratic-CPU merge-key advisory). Dev/transitive only (eslint, mocha,
  glob, c8) — no runtime dependency or behavior change; `npm audit --audit-level=high` is clean.
- Perf: `MountResolver` no longer re-sorts the `api.engines` override map on every `resolve()` —
  entries are normalized and sorted once at construction (the map is now snapshotted: mutating the
  object after `VaultClient` construction no longer affects resolution). The mount cache is now a
  bounded LRU (default 500 entries, `opts.maxCacheSize`) probed by segment-boundary prefix in
  O(path depth) instead of a linear scan over every cached mount, so long-lived services against
  many/dynamic mounts get bounded memory and lookup cost. Measured at 200k worst-case resolves:
  engines lookup 1191ms → 34ms (50 entries), cache lookup 1019ms → 149ms (500 mounts). Also adds
  test coverage for the previously untested empty-detection-response error. Closes #108.
- Internal refactor: unify the copy-pasted request pipeline in `VaultClient`. `update()`, the raw
  `request()`, and the KV v2-only helpers now delegate to the single `__resolveAndRequest` entry
  point (one `resolver.resolve()` call site instead of three). No behavior change — the pipeline
  is locked by new characterization tests across v1/v2 mounts, namespaces, and extra headers.
  Closes #110.
- Non-2xx Vault responses are now rejected with a typed `VaultHttpError` (part of the `VaultError`
  hierarchy, exported from the errors module), so callers can `instanceof`-check HTTP failures.
  Backward compatible: the message (`"<status> - <body text>"`) and the `statusCode`/`error`
  properties are unchanged, and the thrown value is still an `instanceof Error`.
- Auth backends now fail fast with `InvalidArgumentsError` when a required config field is missing:
  `role_id` for AppRole, `role` for IAM and Kubernetes (previously only Token auth validated its
  input, and a missing/empty config surfaced later as an unhelpful login failure or `TypeError`).
  Valid configurations behave exactly as before.

# 2.0.4 Release notes (2026-07-02)

- CI: make the quality gates actually enforce. `c8` now runs with `check-coverage` and per-metric
  thresholds (statements/branches/functions/lines) pinned just below the current measured coverage,
  so a coverage regression fails the `coverage` job instead of silently passing. Linting now covers
  `test/` in addition to `src/` (`eslint src/ test/`), catching stray unused imports/vars in the
  ~19 test files that were previously unchecked. The `npm audit --audit-level=high` choice is now
  documented in the workflow. No runtime behavior change.
- `VaultError` now accepts the standard `{ cause }` option (`new VaultError(msg, { cause })`) and
  exposes it as `error.cause`, so wrapped/underlying errors can be chained. Backward compatible —
  omitting the option leaves `cause` undefined.

# 2.0.3 Release notes (2026-07-02)

- Fix (behavior change): apply `X-Vault-Namespace` to **every** request. The header was previously
  built independently by the AppRole and IAM backends and by `VaultClient` for KV operations, but was
  **missing from token lookup/renewal (`/auth/token/lookup-self`, `/auth/token/renew-self`) for all
  backends, and from Kubernetes login entirely**. Against a namespaced Vault this silently sent those
  requests to the **root** namespace, so Token and Kubernetes auth were effectively broken with
  namespaces. The namespace is now injected in a single place — `VaultApiClient` — so login, lookup,
  renewal, and secret operations all inherit it for every auth backend. `Token` and `Kubernetes`
  gain namespace support as a result. `api.namespace` is now the canonical config location;
  `auth.config.namespace` continues to work. If you relied on the previous (buggy) behavior where
  lookup/renewal hit the root namespace, this changes which namespace those calls target. Closes #106.

# 2.0.2 Release notes (2026-07-02)

- Security: stop logging the raw Vault `client_token` at debug level. The AppRole (`VaultAppRoleAuth`)
  and AWS IAM (`VaultIAMAuth`) backends logged `auth.client_token` verbatim on every successful
  login, and `VaultBaseAuth` logged the raw token id when arming the renewal timer. With a custom
  debug logger wired up — exactly what the README recommends — this wrote a replayable Vault token
  into durable logs on every authentication. These sites now log the non-sensitive token
  `accessor` instead. This completes the same class of fix shipped for the Kubernetes backend and
  response bodies in 2.0.1. Closes #104.

# 2.0.1 Release notes (2026-06-16)

- Security: stop logging secrets at debug level. The Kubernetes auth backend no longer logs the
  service-account JWT or the issued Vault client token, and `VaultApiClient` no longer logs full
  response bodies (which carry auth tokens and secret reads). Debug logs now record only
  non-sensitive metadata — token paths, request method/URI, and HTTP status codes.
- Dependencies: drop four runtime dependencies. `bluebird` and `assign-deep` are replaced with
  native promises and `lodash`; `pretty-ms` and `url-join` are inlined as small helpers (their
  latest majors are ESM-only and cannot be used from this CommonJS package). The `lodash` floor is
  raised to `^4.17.21`. Runtime dependencies are now `@aws-sdk/credential-providers`, `aws4`,
  `lodash`, and `long-timeout`.
- Reject malformed substitution values whose path or key is empty (e.g. `#value` or `path#`) with
  `InvalidArgumentsError`, instead of failing later with a less clear error.

# 2.0.0 Release notes (2026-06-12)

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
- [BREAKING] Minimum supported Node.js is now 18.0.0 (was 14.0.0); the client relies on native `fetch`. Note: on some Node.js 18.x environments, `fetch` may be treated as experimental and require `--experimental-fetch`; use a newer Node.js version for fully nonexperimental `fetch` behavior.
- Auth token: derive expiry from Vault's authoritative `expire_time` (RFC3339), falling back to
  `ttl` only when absent. Closes #51.
- Raise `AuthTokenExpiredError` for expired non-refreshable tokens instead of silently using a
  stale token. Closes #50.
- Replace deprecated `new Buffer()` with `Buffer.from()` in IAM auth STS body encoding. Closes #52.

# 1.0.0 Release notes (2023-08-02)

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
