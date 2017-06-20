# Vault Node.JS Client

A Vault Client implemented in pure javascript for https://github.com/hashicorp/vault.

## Install
```
npm install --save node-vault-client
```

## Example

```javascript
const VaultClient = require('node-vault-js');

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
