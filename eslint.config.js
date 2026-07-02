const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Test files are ESM (.mjs) and run under Mocha, so they need the BDD globals
    // (describe/it/before/after/…) on top of the Node globals above.
    files: ['test/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.mocha,
      },
    },
  },
  {
    ignores: ['node_modules/', 'coverage/'],
  },
];
