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
    externals: [
        // Native audio addons stay as runtime requires — webpack can't
        // bundle binary .node files, and the JS wrappers around them
        // load the .node via relative paths that only resolve correctly
        // when the wrappers stay on disk (alongside the binary). Both
        // are shipped unpacked from asar so they're available at
        // runtime.
        function ({ request }, callback) {
            if (request && /(?:^|[\\/])native[\\/](?:mac|win)audio(?:$|[\\/])/.test(request)) {
                return callback(null, `commonjs ${request}`);
            }
            callback();
        },
        {
            '@jitsi/electron-sdk': 'require(\'@jitsi/electron-sdk\')',
            'electron-context-menu': 'require(\'electron-context-menu\')',
            'electron-reload': 'require(\'electron-reload\')',
            'posthog-node': 'require(\'posthog-node\')'
        }
    ],
    resolve: {
        modules: [
            path.resolve('./node_modules')
        ]
    }
};

