const { app } = require('electron');

const appEnv = process.env.APP_ENV || (app.isPackaged ? 'production' : 'staging');
const isProd = appEnv === 'production';

const URLS = {
    production: {
        landing: 'https://sonacove.com/dashboard',
        meetRoot: 'https://sonacove.com/meet',
        authHost: 'auth.sonacove.com',
        allowedHosts: [ 'sonacove.com', 'auth.sonacove.com', 'gravatar.com', 'customer-portal.paddle.com' ],
        defaultServerURL: 'https://sonacove.com'
    },
    staging: {
        // landing: 'https://sonacove.catfurr.workers.dev/dashboard',
        landing: 'https://45281761-sona-app.catfurr.workers.dev/meet/testmeeting1',
        // meetRoot: 'https://ca832c9c-sona-app.catfurr.workers.dev/meet',
        meetRoot: 'https://45281761-sona-app.catfurr.workers.dev/meet/testmeeting1',
        authHost: 'staj.sonacove.com',
        allowedHosts: ['ca832c9c-sona-app.catfurr.workers.dev', 'localhost', 'sonacove.catfurr.workers.dev', 'gravatar.com', 'sandbox-customer-portal.paddle.com', 'staj.sonacove.com' ],
        defaultServerURL: 'https://sonacove.com'
    }
};

const currentConfig = isProd ? URLS.production : URLS.staging;

module.exports = { isProd,
    currentConfig };
