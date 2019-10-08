'use strict';

const child_process = require('child_process');

function pKiller(processRef) {
    return new Promise(function (resolve, reject) {
        processRef.on('exit', (/*code, signal*/) => {
            //console.log('child process terminated due to receipt of signal '+signal);
            resolve();
        });
        processRef.on('error', err => {
            reject(err);
        });

        processRef.kill();
    });
}

module.exports = function () {
    return new Promise(function (resolve, reject) {
        const processRef = child_process.spawn('/usr/local/bin/vault', ['server', '-dev']);

        let dataAcc = '';
        processRef.stdout.on('data', function(data) {
            if (dataAcc === null) {
                return;
            }

            dataAcc += data.toString(); //we receive binary data here
            const found = dataAcc.match(/Root Token: ([a-z0-9\-]+)\n/i);

            if (found !== null) {
                dataAcc = null;
                resolve({
                    rootToken: found[1],
                    kill: () => pKiller(processRef),
                });
            }
        });

        processRef.on('error', err => {
            reject(err);
        });
    });
};
