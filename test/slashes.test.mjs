/**
 * Unit tests for the regex-free slash trimming helpers (CodeQL js/polynomial-redos).
 */

import { expect } from 'chai';
import { trimTrailingSlashes, trimSlashes } from '../src/slashes.js';

// Long enough that the replaced /\/+$/ took seconds (it is quadratic), short enough that a
// linear scan stays well under a millisecond.
const SLASH_RUN = 'a' + '/'.repeat(100000) + 'x';

function elapsedMs(fn) {
    const start = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
}

describe('slashes', function () {
    describe('trimTrailingSlashes', function () {
        const cases = [
            ['', ''],
            ['/', ''],
            ['///', ''],
            ['secret', 'secret'],
            ['secret/', 'secret'],
            ['secret///', 'secret'],
            ['/secret/', '/secret'],
            ['team/kv/', 'team/kv'],
            ['a//b', 'a//b'],
        ];
        cases.forEach(([input, expected]) => {
            it(`'${input}' => '${expected}'`, function () {
                expect(trimTrailingSlashes(input)).to.equal(expected);
                expect(trimTrailingSlashes(input)).to.equal(input.replace(/\/+$/, ''));
            });
        });

        it('runs in linear time on a long run of slashes that does not end the string', function () {
            let result;
            expect(elapsedMs(() => { result = trimTrailingSlashes(SLASH_RUN); })).to.be.below(250);
            expect(result).to.equal(SLASH_RUN);
        });
    });

    describe('trimSlashes', function () {
        const cases = [
            ['', ''],
            ['/', ''],
            ['//ns1/ns2//', 'ns1/ns2'],
            ['ns1', 'ns1'],
            ['/secret', 'secret'],
            ['secret/', 'secret'],
            ['a//b', 'a//b'],
        ];
        cases.forEach(([input, expected]) => {
            it(`'${input}' => '${expected}'`, function () {
                expect(trimSlashes(input)).to.equal(expected);
                expect(trimSlashes(input)).to.equal(input.replace(/^\/+|\/+$/g, ''));
            });
        });

        it('runs in linear time on a long run of slashes that does not end the string', function () {
            let result;
            expect(elapsedMs(() => { result = trimSlashes(SLASH_RUN); })).to.be.below(250);
            expect(result).to.equal(SLASH_RUN);
        });
    });
});
