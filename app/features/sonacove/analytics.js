'use strict';

const { app } = require('electron');
const { PostHog } = require('posthog-node');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { isProd } = require('./config');

const POSTHOG_API_KEY = 'phc_6DQmHYaWUYWvs6rLBWQooIrmPadIgT3fK61s8DAfIH0';
const POSTHOG_HOST = 'https://e.sonacove.com';

let posthog = null;
let distinctId = null;

/**
 * Returns a persistent anonymous installation ID.
 * Generated once on first launch, stored in the Electron userData directory.
 * Never contains any personally identifiable information.
 *
 * @returns {string} UUID v4
 */
function getDistinctId() {
    if (distinctId) {
        return distinctId;
    }

    const idFile = path.join(app.getPath('userData'), '.analytics_id');

    try {
        if (fs.existsSync(idFile)) {
            const stored = fs.readFileSync(idFile, 'utf8').trim();

            if (stored) {
                distinctId = stored;

                return distinctId;
            }
        }
    } catch (_) { /* ignore read errors */ }

    // Generate and persist a new installation ID
    distinctId = crypto.randomUUID();
    try {
        fs.writeFileSync(idFile, distinctId, 'utf8');
    } catch (_) { /* ignore write errors */ }

    return distinctId;
}

/**
 * Base properties attached to every event.
 * Matches the `env` / `app` registration used by the dashboard and Jitsi Meet.
 *
 * @returns {Object}
 */
function baseProperties() {
    return {
        app: 'electron',
        env: isProd ? 'prod' : 'staging',
        app_version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron_version: process.versions.electron,
        node_version: process.versions.node,
        is_packaged: app.isPackaged
    };
}

/**
 * Initializes the PostHog analytics client.
 * No-ops gracefully when the API key is not yet configured.
 *
 * @returns {void}
 */
function initAnalytics() {
    console.log(POSTHOG_API_KEY)
    if (!POSTHOG_API_KEY) {
        console.warn('⚠️  PostHog: API key not configured — Electron analytics disabled.');

        return;
    }

    posthog = new PostHog(POSTHOG_API_KEY, {
        host: POSTHOG_HOST,

        // Batch up to 20 events before flushing, or every 10 s, whichever comes first.
        flushAt: 20,
        flushInterval: 10000
    });

    console.log('✅ PostHog analytics initialized (Electron main process)');
}

/**
 * Captures an analytics event from the main process.
 *
 * @param {string} event - PostHog event name.
 * @param {Object} [properties] - Additional event properties.
 * @returns {void}
 */
function capture(event, properties = {}) {
    if (!posthog) {
        return;
    }

    posthog.capture({
        distinctId: getDistinctId(),
        event,
        properties: {
            ...baseProperties(),
            ...properties
        }
    });
}

/**
 * Flushes all queued events and shuts down the PostHog client.
 * Must be awaited before the process exits to avoid dropping events.
 *
 * @returns {Promise<void>}
 */
async function shutdownAnalytics() {
    if (!posthog) {
        return;
    }

    try {
        await posthog.shutdown();
    } catch (err) {
        console.error('PostHog shutdown error:', err);
    }
}

module.exports = {
    initAnalytics,
    capture,
    shutdownAnalytics,
    getDistinctId
};
