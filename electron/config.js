require('dotenv').config();

const packageJson = require('../package.json');

const appEnv = process.env.APP_ENV || packageJson.appEnv || 'production';
const isProd = appEnv === 'production';

console.log(`Config loaded. Environment: ${appEnv}`);

const URLS = {
    production: {
        landing: 'https://sonacove.com/dashboard',
        allowedHosts: ['sonacove.com', 'auth.sonacove.com']
    },
    staging: {
        landing: 'https://sonacove.catfurr.workers.dev/dashboard',
        meetRoot: 'https://a597c4d3-sona-app.catfurr.workers.dev',
        allowedHosts: [
            'sonacove.catfurr.workers.dev',
            'a597c4d3-sona-app.catfurr.workers.dev',
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
