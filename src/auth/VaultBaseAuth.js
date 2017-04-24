'use strict';

class VaultBaseAuth {

    /**
     * @param {VaultApiClient} apiClient
     */
    constructor(apiClient) {
        this.__apiClient = apiClient;
    }

    getAuthToken() {
        throw new Error('Method should be overridden');
    }

}

module.exports = VaultBaseAuth;
