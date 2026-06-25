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
        'controls-bar-preload': './app/features/controls-bar/controls-bar-preload.js',
        'share-border-preload': './app/features/share-border/share-border-preload.js',
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

        // ⚠️ Renderer assets are copied per-file. A NEW file in a renderer dir
        // (e.g. a split-out *.js for the PiP / controls-bar) MUST be added here,
        // or it silently 404s in build/ and the window loads blank.
        new CopyPlugin({
            patterns: [
                { from: 'app/splash.html', to: 'splash.html' },
                { from: 'app/error.html', to: 'error.html' },
                { from: 'app/features/pip/participant-panel.html', to: 'participant-panel.html' },
                { from: 'app/features/pip/participant-panel.css', to: 'participant-panel.css' },
                { from: 'app/features/pip/participant-panel.js', to: 'participant-panel.js' },
                { from: 'app/features/controls-bar/controls-bar.html', to: 'controls-bar.html' },
                { from: 'app/features/controls-bar/controls-bar.css', to: 'controls-bar.css' },
                { from: 'app/features/controls-bar/controls-bar.js', to: 'controls-bar.js' },
                { from: 'app/features/controls-bar/fonts', to: 'fonts' },
                { from: 'app/features/share-border/share-border.html', to: 'share-border.html' },
                { from: 'app/features/share-border/share-border.js', to: 'share-border.js' },
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
            const match = request && request.match(/(?:^|[\\/])native[\\/](mac|win)audio(?:$|[\\/])/);

            if (match) {
                // Source files (e.g. app/features/mac-audio.js) require the
                // addon via `../../native/Xaudio` — correct from source,
                // but the bundle output lives in build/ where the same
                // relative path escapes the repo. Rewrite to a path that
                // resolves correctly from build/main.js at runtime.
                return callback(null, `commonjs ../native/${match[1]}audio`);
            }
            callback();
        },
        {
            '@jitsi/electron-sdk': 'require(\'@jitsi/electron-sdk\')',
            'electron-context-menu': 'require(\'electron-context-menu\')',
            'electron-reload': 'require(\'electron-reload\')',
            'electron-updater': 'require(\'electron-updater\')',
            'posthog-node': 'require(\'posthog-node\')',
            // Must stay external so its Windows impl's `__dirname` resolves at
            // runtime to the real on-disk loudness/impl/windows/ folder. Webpack
            // would otherwise inline `__dirname` as a compile-time relative path,
            // breaking the bundled .exe lookup in packaged builds.
            // Pairs with `asarUnpack` in package.json and patches/loudness+0.4.2.patch.
            'loudness': 'require(\'loudness\')'
        }
    ],
    resolve: {
        modules: [
            path.resolve('./node_modules')
        ]
    }
};

