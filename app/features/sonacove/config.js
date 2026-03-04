const { app } = require('electron');

// Staging CI patches app name/productName to include "staging".
// app.name may return 'sonacove-staging' (name) or 'Sonacove Staging' (productName)
// depending on Electron version, so check case-insensitively.
const isStagingBuild = (app.name || '').toLowerCase().includes('staging');
const appEnv = process.env.APP_ENV
    || (isStagingBuild ? 'staging'
        : app.isPackaged ? 'production'
            : 'staging');
const isProd = appEnv === 'production';

const URLS = {
    production: {
        landing: 'https://sonacove.com/dashboard',
        meetRoot: 'https://sonacove.com/meet',
        allowedHosts: [ 'sonacove.com', 'gravatar.com', 'customer-portal.paddle.com' ],
        defaultServerURL: 'https://sonacove.com'
    },
    staging: {
        landing: 'https://sonacove.catfurr.workers.dev/dashboard',
        meetRoot: 'https://675ad424-sona-app.catfurr.workers.dev/meet',
        allowedHosts: [ '675ad424-sona-app.catfurr.workers.dev', 'sonacove.catfurr.workers.dev', 'localhost', 'gravatar.com', 'sandbox-customer-portal.paddle.com', 'staj.sonacove.com' ],
        defaultServerURL: 'https://sonacove.catfurr.workers.dev'
    }
};

const currentConfig = isProd ? URLS.production : URLS.staging;

module.exports = { isProd,
    currentConfig };
