/**
 * The environment for code verify-package installs and loads outside the lockfile (#229).
 *
 * In the publish job the runtime dependencies are resolved fresh from the registry and then
 * loaded in a child process. --ignore-scripts stops install scripts, not code that runs when a
 * module loads, so the child must not inherit the credentials the job holds: the OIDC token
 * request (npm trusted publishing), the Actions runtime token, and any npm or GitHub token.
 */
const CREDENTIAL = /^(ACTIONS_ID_TOKEN_REQUEST_|ACTIONS_RUNTIME_TOKEN$|ACTIONS_RESULTS_URL$|ACTIONS_CACHE_URL$|NODE_AUTH_TOKEN$|NPM_TOKEN$|NPM_CONFIG__AUTH|GITHUB_TOKEN$|GH_TOKEN$)/i;

export function sandboxEnv(env = process.env) {
    return Object.fromEntries(Object.entries(env).filter(([key]) => !CREDENTIAL.test(key)));
}
