module.exports = {
  env: {
    commonjs: true,
    es6: true,
    node: true,
  },
  extends: [
    'airbnb-base',
  ],
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly',
  },
  parserOptions: {
    ecmaVersion: 2018,
  },
  rules: {
    "indent": ["error", 4],
    "no-underscore-dangle": [0],
    "no-param-reassign": [0],
    "max-len": ["error", { code: 150, ignoreComments:true }],
    "radix": [0],
    "func-names": [0],
    "class-methods-use-this": [0],
    "no-buffer-constructor":[0],
    "no-restricted-syntax": [0],
    "no-prototype-builtins":[0],
    "no-continue": [0],
    "global-require": [1],
    "import/no-dynamic-require":[1],
    "import/no-unresolved": [1]
  },
};
