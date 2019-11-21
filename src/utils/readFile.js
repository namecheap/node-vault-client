const { readFile } = require('fs');

module.exports = function (filePath) {
    return new Promise((resolve, reject) => {
        readFile(filePath, (err, data) => {
            if(err) {
                console.log(`Error appears: ${err.message}`)
                return reject(err)
            } else {
                const jwt = data.toString();
                console.log(jwt);
                return resolve(jwt);
            }
        });
    });
};
