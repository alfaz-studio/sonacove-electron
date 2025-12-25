require('dotenv').config();

const packageJson = require('../package.json');

const appEnv = process.env.APP_ENV || packageJson.appEnv || 'production';
const isProd = appEnv === 'production';

console.log(`Config loaded. Environment: ${appEnv}`);

const URLS = {
    production: {
        landing: 'https://sonacove.com/dashboard',
        authHost: 'auth.sonacove.com',
        allowedHosts: [
            'sonacove.com',
            'auth.sonacove.com'
        ]
    },
    staging: {
        meetRoot: 'https://c2e09f48-sona-app.catfurr.workers.dev',
        landing: 'https://2a74eb17-sonacove.catfurr.workers.dev/dashboard',
        // meetRoot: 'https://localhost:5173',
        authHost: 'staj.sonacove.com',
        allowedHosts: [
            'sonacove.catfurr.workers.dev',
            '2a74eb17-sonacove.catfurr.workers.dev',
            'ad60ea0a-sona-app.catfurr.workers.dev',
            'staj.sonacove.com',
            'localhost'
        ]
    }
};

const currentConfig = isProd ? URLS.production : URLS.staging;

module.exports = {
    isProd,
    currentConfig
};
