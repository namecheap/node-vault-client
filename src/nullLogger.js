'use strict';

const _ = require('lodash');

module.exports = _.fromPairs(
    _.map(['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'], (level) => [level, _.noop])
);
