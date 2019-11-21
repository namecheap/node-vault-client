const { readFile } = require('fs');

module.exports = function (filePath) {
    return new Promise((resolve, reject) => {
        readFile(filePath, (err, data) => {
            return err ? reject(err) : resolve(data.toString());
        });
    });
};
