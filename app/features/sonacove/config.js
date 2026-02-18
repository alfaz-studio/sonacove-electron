const { app } = require('electron');

const appEnv = process.env.APP_ENV || (app.isPackaged ? 'production' : 'staging');
const isProd = appEnv === 'production';

const URLS = {
    production: {
        landing: 'https://sonacove.com/dashboard',
        meetRoot: 'https://sonacove.com/meet',
        allowedHosts: [ 'sonacove.com', 'gravatar.com', 'customer-portal.paddle.com' ],
        defaultServerURL: 'https://sonacove.com'
    },
    staging: {
        landing: 'https://26c4a307-sonacove.catfurr.workers.dev/dashboard',
        // landing: 'http://localhost:4321/dashboard',
        meetRoot: 'https://dea29a3a-sona-app.catfurr.workers.dev/meet',
        // meetRoot: 'https://localhost:5173/meet/',
        allowedHosts: [ 'dea29a3a-sona-app.catfurr.workers.dev', '26c4a307-sonacove.catfurr.workers.dev', 'localhost', 'gravatar.com', 'sandbox-customer-portal.paddle.com', 'staj.sonacove.com' ],
        defaultServerURL: 'https://sonacove.com'
    }
};

const currentConfig = isProd ? URLS.production : URLS.staging;

module.exports = { isProd,
    currentConfig };
