/**
 * Eslint config.
 */

'use strict';

// public
module.exports = {
    // base rules
    extends: require.resolve('cjs-eslint-config/.eslintrc.js'),

    env: {
        commonjs: true,
        node: true,
        es6: true
    }
};
