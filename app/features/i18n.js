'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const isDev = require('electron-is-dev');

let translations = {};

/**
 * Loads locale JSON into memory.
 * Must be called after app is ready.
 */
function initI18n() {
    const localesDir = isDev
        ? path.join(process.cwd(), 'app', 'locales')
        : path.join(app.getAppPath(), 'build', 'locales');

    const filePath = path.join(localesDir, 'en.json');

    try {
        translations = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.warn('[i18n] Failed to load locale:', err.message);
    }
}

/**
 * Translation function. Resolves dot-notated keys and interpolates {{params}}.
 *
 * @param {string} key - Dot-notated key, e.g. 'update.noUpdatesMessage'.
 * @param {Object} [params] - Values to interpolate, e.g. { version: '1.0' }.
 * @returns {string} Translated string, or the key itself if not found.
 */
function t(key, params) {
    const value = key.split('.').reduce((obj, k) => obj?.[k], translations);

    if (typeof value !== 'string') {
        return key;
    }

    if (!params) {
        return value;
    }

    return value.replace(/\{\{(\w+)\}\}/g, (_, name) =>
        params[name] !== undefined ? params[name] : `{{${name}}}`
    );
}

module.exports = { initI18n, t };
