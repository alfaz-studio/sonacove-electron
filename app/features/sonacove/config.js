const { app } = require('electron');

// Staging CI patches app name to 'sonacove-staging', so detect that.
// Local dev (not packaged) also defaults to staging.
const appEnv = process.env.APP_ENV
    || (app.name === 'sonacove-staging' ? 'staging'
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
