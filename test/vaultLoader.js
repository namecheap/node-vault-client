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
        const processRef = child_process.exec('killall vault || true && vault server -dev');

        processRef.stdout.on('data', function(data) {
            const found = data.match(/^Root Token: ([a-z0-9\-]+)$/mi);

            if (found !== null) {
                resolve({
                    token: found[1],
                    kill: () => pKiller(processRef),
                });
            }
        });

        processRef.on('error', err => {
            reject(err);
        });
    });
};
