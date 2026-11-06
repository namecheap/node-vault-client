/**
 * Mocha root hooks for the e2e suites (#220). A client holding a renewable token arms a renewal
 * timer that keeps Node's event loop alive, so a suite that never calls `client.close()` makes
 * plain `mocha` (without --exit) or an IDE runner hang after the summary. The npm scripts keep
 * --exit, which hides that; this fails the run instead, naming where each timer still pending
 * after the last test came from, and cancels those timers so the run exits either way.
 *
 * Loaded with `mocha --require test/e2e/renewal-timer-guard.mjs` by the test:e2e* scripts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';

// The same module object src/auth/VaultBaseAuth.js uses; it reads lt.setTimeout per call.
const lt = createRequire(import.meta.url)('long-timeout');

// Where a timer came from. A renewal timer that fires re-arms from inside its own callback, so
// the label rides the async context the client was first used in rather than whatever test
// happens to run when it re-arms. Hooks get a label of their own.
const origin = new AsyncLocalStorage();
let current = '(a hook that ran before the first test)';

const pending = new Map(); // timer -> origin label
const { setTimeout: armTimer, clearTimeout: clearTimer } = lt;

lt.setTimeout = function (listener, ...rest) {
    const timer = armTimer.call(this, function (...args) {
        pending.delete(timer);
        return listener.apply(this, args);
    }, ...rest);
    pending.set(timer, origin.getStore() ?? current);
    return timer;
};

lt.clearTimeout = function (timer) {
    pending.delete(timer);
    return clearTimer.call(this, timer);
};

function label(text) {
    current = text;
    origin.enterWith(text);
}

export const mochaHooks = {
    beforeEach() {
        label(this.currentTest.fullTitle());
    },
    afterEach() {
        label(`(a hook that ran after "${this.currentTest.fullTitle()}")`);
    },
    afterAll() {
        if (pending.size === 0) {
            return;
        }
        const origins = [...new Set(pending.values())].map((text) => `  - ${text}`).join('\n');
        // Cancel them, or the failure itself would still hang a run without --exit.
        for (const timer of pending.keys()) {
            clearTimer(timer);
        }
        pending.clear();
        throw new Error(
            'Token renewal timers are still armed after the last test, which keeps the process ' +
            'from exiting without --exit (#220). Close the clients holding renewable tokens that ' +
            `were first used in:\n${origins}`
        );
    },
};
