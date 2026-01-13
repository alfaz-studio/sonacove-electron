const { app } = require('electron');

const appEnv = process.env.APP_ENV || (app.isPackaged ? 'production' : 'staging');
const isProd = appEnv === 'production';

const URLS = {
    production: {
        landing: 'https://sonacove.com/dashboard',
        meetRoot: 'https://sonacove.com/meet',
        authHost: 'auth.sonacove.com',
        allowedHosts: [ 'sonacove.com', 'auth.sonacove.com' ],
        defaultServerURL: 'https://sonacove.com'
    },
    staging: {
        landing: 'https://sonacove.catfurr.workers.dev/dashboard',
        meetRoot: 'https://localhost:5173/meet/',
        authHost: 'staj.sonacove.com',
        allowedHosts: [ 'localhost', 'sonacove.catfurr.workers.dev' ],
        defaultServerURL: 'https://sonacove.com'
    }
};

const currentConfig = isProd ? URLS.production : URLS.staging;

module.exports = { isProd,
    currentConfig };
