const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
    target: 'electron-main',
    entry: {
        main: './main.js',
        preload: './app/preload/preload.js',
        'overlay-preload': './app/preload/overlay-preload.js',
        'participant-panel-preload': './app/features/pip/participant-panel-preload.js',
    },
    output: {
        path: path.resolve('./build'),
        filename: '[name].js'
    },
    node: {
        __dirname: true
    },
    plugins: [
        new webpack.IgnorePlugin({ resourceRegExp: /^supports-color$/ }),
        new CopyPlugin({
            patterns: [
                { from: 'app/splash.html', to: 'splash.html' },
                { from: 'app/error.html', to: 'error.html' },
                { from: 'app/features/pip/participant-panel.html', to: 'participant-panel.html' },
                { from: 'app/features/pip/participant-panel.css', to: 'participant-panel.css' },
                { from: 'app/locales', to: 'locales' }
            ]
        })
    ],
    externals: [ {
        '@jitsi/electron-sdk': 'require(\'@jitsi/electron-sdk\')',
        'electron-context-menu': 'require(\'electron-context-menu\')',
        'electron-reload': 'require(\'electron-reload\')',
        'posthog-node': 'require(\'posthog-node\')'
    } ],
    resolve: {
        modules: [
            path.resolve('./node_modules')
        ]
    }
};

