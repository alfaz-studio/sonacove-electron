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

console.log(`Running in ${appEnv} environment (isProd: ${isProd})`);

const URLS = {
    production: {
        landing: 'http://localhost:4321/dashboard',
        meetRoot: 'https://localhost:5175/meet',
        allowedHosts: [ 'localhost','sonacove.com', 'gravatar.com', 'customer-portal.paddle.com' ],
        defaultServerURL: 'https://sonacove.com'
    },
    // ⚠ staging-launcher/main.js patchMainJs() replaces these URL strings
    // directly in compiled builds — keep in sync with the patterns there.
    staging: {
        landing: 'https://localhost:5175/meet/test1234',
        meetRoot: 'https://localhost:5175/meet/test1234',
        allowedHosts: [ 'sona-app.catfurr.workers.dev', 'sonacove.catfurr.workers.dev', 'localhost', 'gravatar.com', 'sandbox-customer-portal.paddle.com', 'staj.sonacove.com' ],
        defaultServerURL: 'https://sonacove.com'
    }
};

// Allow the staging launcher (or dev env) to override URLs via environment variables.
// This lets testers point staging builds at custom preview deployments.
if (!isProd) {
    if (process.env.STAGING_LANDING_URL) {
        URLS.staging.landing = process.env.STAGING_LANDING_URL;
        const host = new URL(process.env.STAGING_LANDING_URL).hostname;

        if (!URLS.staging.allowedHosts.includes(host)) {
            URLS.staging.allowedHosts.push(host);
        }
    }
    if (process.env.STAGING_MEET_URL) {
        URLS.staging.meetRoot = process.env.STAGING_MEET_URL;
        const host = new URL(process.env.STAGING_MEET_URL).hostname;

        if (!URLS.staging.allowedHosts.includes(host)) {
            URLS.staging.allowedHosts.push(host);
        }
    }
}

const currentConfig = isProd ? URLS.production : URLS.staging;

module.exports = { isProd,
    currentConfig };
