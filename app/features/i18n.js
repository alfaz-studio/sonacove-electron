'use strict';

const { app } = require('electron');
const rosetta = require('rosetta');
const path = require('path');
const fs = require('fs');

const i18n = rosetta();

// Supported locales — add new ones here and create the matching JSON file.
const SUPPORTED_LOCALES = [ 'en' ];
const DEFAULT_LOCALE = 'en';

/**
 * Loads all locale files from app/locales/ into rosetta.
 * Must be called after app is ready (or at module load time in webpack bundle).
 */
function loadLocales() {
    const localesDir = path.resolve(__dirname, '..', 'locales');

    for (const locale of SUPPORTED_LOCALES) {
        const filePath = path.join(localesDir, `${locale}.json`);

        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            i18n.set(locale, data);
        } catch (err) {
            console.warn(`[i18n] Failed to load locale "${locale}":`, err.message);
        }
    }
}

/**
 * Detects the best locale from Electron's app.getLocale().
 * Falls back to DEFAULT_LOCALE if the system locale isn't supported.
 *
 * @returns {string} The locale code.
 */
function detectLocale() {
    const systemLocale = app.getLocale(); // e.g. 'en-US', 'ar', 'tr'
    const lang = systemLocale.split('-')[0]; // e.g. 'en', 'ar', 'tr'

    return SUPPORTED_LOCALES.includes(lang) ? lang : DEFAULT_LOCALE;
}

/**
 * Initializes i18n: loads locale files and sets the active locale.
 * Call once at app startup (after app 'ready' or in the main entry).
 */
function initI18n() {
    loadLocales();
    i18n.locale(detectLocale());
}

/**
 * Translation function. Use throughout the app.
 *
 * @param {string} key - Dot-notated translation key.
 * @param {Object} [params] - Interpolation values.
 * @returns {string} The translated string, or the key if not found.
 */
function t(key, params) {
    return i18n.t(key, params) || key;
}

/**
 * Returns the full translation table for the current locale.
 * Useful for injecting into renderer pages (error.html, titlebar).
 *
 * @returns {Object} The translation object.
 */
function getTranslations() {
    return i18n.table(i18n.locale());
}

module.exports = { initI18n,
    t,
    getTranslations };
