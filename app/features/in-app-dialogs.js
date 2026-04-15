'use strict';

/**
 * In-app dialog injection module.
 *
 * Provides toast notifications and modal dialogs injected directly into the
 * remote web page via webContents.executeJavaScript(). Replaces native
 * Electron dialogs with branded, in-app UI.
 *
 * IPC responses use window.sonacoveElectronAPI.ipc.send() from the preload.
 */

// ── Design Tokens ───────────────────────────────────────────────────────

const ACCENT = '#F4511E';
const ACCENT_HOVER = '#ff7043';
const ACCENT_BG = 'rgba(244,81,30,0.1)';
const ERROR_COLOR = '#e74c3c';
const ERROR_BG = 'rgba(231,76,60,0.1)';

const TOAST_CSS = 'position:fixed;top:48px;right:16px;z-index:999999;width:320px;'
    + 'background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:16px;'
    + 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;'
    + 'color:#2d2d3a;box-shadow:0 4px 24px rgba(0,0,0,0.12);'
    + 'animation:snc-slide-in 0.35s ease forwards;overflow:hidden;';

// ── SVG Icon Paths ──────────────────────────────────────────────────────

const SVG_INFO = '<circle cx="12" cy="12" r="10"/>'
    + '<line x1="12" y1="16" x2="12" y2="12"/>'
    + '<line x1="12" y1="8" x2="12.01" y2="8"/>';

const SVG_WARNING = '<circle cx="12" cy="12" r="10"/>'
    + '<line x1="12" y1="8" x2="12" y2="12"/>'
    + '<line x1="12" y1="16" x2="12.01" y2="16"/>';

const SVG_DOWNLOAD = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
    + '<polyline points="7 10 12 15 17 10"/>'
    + '<line x1="12" y1="15" x2="12" y2="3"/>';

// ── Shared Helpers ──────────────────────────────────────────────────────

/**
 * Escapes a string for safe embedding in innerHTML within JS template literals.
 *
 * HTML entities (&, <, >, ") are escaped first because values end up
 * in innerHTML.  The \\ and \' escapes are required because the escaped
 * value is placed inside '…'-delimited string literals in the
 * generated JS — do not remove them.
 *
 * @param {string} str - The input string.
 * @returns {string} The escaped string.
 */
function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
}

/**
 * Builds an SVG icon string.
 *
 * @param {number} size - Width/height in px.
 * @param {string} color - Stroke color.
 * @param {string} paths - Inner SVG elements.
 * @returns {string} Complete SVG markup.
 */
function svgIcon(size, color, paths) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
        + `stroke="${color}" stroke-width="2" stroke-linecap="round" `
        + `stroke-linejoin="round">${paths}</svg>`;
}

/**
 * Returns JS code for a toast slide-out dismiss animation.
 * Uses forced reflow (void offsetHeight) to ensure the transition fires
 * after clearing the slide-in animation.
 *
 * @param {string} varName - The JS variable referencing the toast element.
 * @returns {string} JS code block.
 */
function slideOutJS(varName) {
    return `${varName}.style.animation='none';`
        + `void ${varName}.offsetHeight;`
        + `${varName}.style.transition='transform 0.3s ease,opacity 0.3s ease';`
        + `${varName}.style.transform='translateX(120%)';${varName}.style.opacity='0';`
        + `setTimeout(function(){${varName}.remove();},300);`;
}

/**
 * Safely injects JavaScript into web contents with error handling.
 *
 * @param {Electron.WebContents} webContents - The target web contents.
 * @param {string} js - The JavaScript code to execute.
 * @param {string} label - A label for the warning message on failure.
 */
function safeInject(webContents, js, label) {
    webContents.executeJavaScript(js)
        .catch(err => console.warn(`Failed to show ${label}:`, err.message));
}

// ── Shared CSS ──────────────────────────────────────────────────────────

const SHARED_STYLES = ''
    + '@keyframes snc-slide-in{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}'
    + '@keyframes snc-progress{from{width:100%}to{width:0%}}'
    + '@keyframes snc-fade-in{from{opacity:0}to{opacity:1}}'
    + '@keyframes snc-scale-in{from{transform:scale(0.95);opacity:0}to{transform:scale(1);opacity:1}}'
    + '.snc-btn{border:none;font-size:13px;font-weight:500;padding:8px 18px;border-radius:8px;cursor:pointer;transition:background 0.15s ease,filter 0.15s ease;}'
    + '.snc-btn:hover{filter:brightness(0.92);}'
    + '.snc-btn:active{filter:brightness(0.85);}';

/**
 * Injects shared CSS keyframes and button styles (idempotent).
 *
 * @returns {string} JS code that ensures the shared style tag exists.
 */
function injectStylesJS() {
    return `var _sid='sonacove-dialog-styles';`
        + `if(!document.getElementById(_sid)){`
        + `var _s=document.createElement('style');_s.id=_sid;`
        + `_s.textContent=${JSON.stringify(SHARED_STYLES)};`
        + `document.head.appendChild(_s);}`;
}

// ── Mutual Exclusion ────────────────────────────────────────────────────
// Only one toast/panel should be visible at a time (About, Info, Update).
// Modals (leave, deeplink) are excluded — they're user-blocking and critical.

const TOAST_PANEL_IDS = ['sonacove-update-toast', 'sonacove-info-toast', 'sonacove-about-panel'];

/**
 * Returns JS code that removes all existing toast/panel elements.
 * Called at the start of each toast/panel injection.
 *
 * @returns {string} JS code block.
 */
function dismissOtherToastsJS() {
    return `${JSON.stringify(TOAST_PANEL_IDS)}.forEach(function(id){`
        + `var el=document.getElementById(id);if(el)el.remove();});`;
}

// ── Toast: Update Ready ─────────────────────────────────────────────────

/**
 * Shows a slide-in toast notification for a downloaded app update.
 *
 * @param {Electron.WebContents} webContents - The target web contents.
 * @param {string} version - The new version number.
 */
function showUpdateToast(webContents, version, strings = {}) {
    const titleText = esc(strings.title);
    const messageText = esc(strings.message);
    const laterText = esc(strings.later);
    const installText = esc(strings.installNow);
    const icon = svgIcon(18, ACCENT, SVG_DOWNLOAD);

    const js = `(function(){
${dismissOtherToastsJS()}
${injectStylesJS()}
var t=document.createElement('div');
t.id='sonacove-update-toast';
t.style.cssText=${JSON.stringify(TOAST_CSS)};
t.innerHTML=''
+'<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;">'
+'<div style="width:36px;height:36px;border-radius:8px;background:${ACCENT_BG};display:flex;align-items:center;justify-content:center;flex-shrink:0;">'
+'${icon}'
+'</div>'
+'<div style="flex:1;min-width:0;">'
+'<div style="font-weight:600;font-size:14px;margin-bottom:2px;color:#2d2d3a;">${titleText}</div>'
+'<div style="font-size:13px;color:#8a8a9a;line-height:1.4;">${messageText}</div>'
+'</div></div>'
+'<div style="display:flex;gap:8px;justify-content:flex-end;">'
+'<button id="snc-toast-later" class="snc-btn" style="background:#fff;border:1px solid #e0e0e0;color:#5a5a6a;">${laterText}</button>'
+'<button id="snc-toast-install" class="snc-btn" style="background:${ACCENT};color:#fff;">${installText}</button>'
+'</div>'
+'<div style="position:absolute;bottom:0;left:0;height:3px;background:rgba(244,81,30,0.35);animation:snc-progress 15s linear forwards;border-radius:0 0 0 12px;"></div>';
document.body.appendChild(t);
var _tm=setTimeout(function(){_dism();},15000);
function _dism(){
clearTimeout(_tm);
${slideOutJS('t')}
try{window.sonacoveElectronAPI.ipc.send('update-toast-action',{action:'dismiss'});}catch(e){}
}
document.getElementById('snc-toast-install').onclick=function(){
clearTimeout(_tm);t.remove();
try{window.sonacoveElectronAPI.ipc.send('update-toast-action',{action:'install'});}catch(e){}
};
document.getElementById('snc-toast-later').onclick=_dism;
})();`;

    safeInject(webContents, js, 'update toast');
}

// ── Modal: Generic ──────────────────────────────────────────────────────

/**
 * Shows a centered modal overlay.
 *
 * @param {Electron.WebContents} webContents - The target web contents.
 * @param {Object} opts - Modal configuration.
 * @param {string} opts.id - Unique DOM element ID.
 * @param {string} opts.title - Modal heading text.
 * @param {string} opts.message - Modal body text.
 * @param {string} opts.confirmLabel - Text for the confirm button.
 * @param {string} opts.confirmColor - CSS background color for the confirm button.
 * @param {string} opts.cancelLabel - Text for the cancel button.
 * @param {string} opts.ipcChannel - IPC channel for the response.
 */
function _showModal(webContents, opts) {
    const id = esc(opts.id);
    const title = esc(opts.title);
    const message = esc(opts.message);
    const confirmLabel = esc(opts.confirmLabel);
    const cancelLabel = esc(opts.cancelLabel);
    const channel = esc(opts.ipcChannel);
    const confirmColor = esc(opts.confirmColor);

    const js = `(function(){
var old=document.getElementById('${id}');if(old)old.remove();
${injectStylesJS()}
var m=document.createElement('div');
m.id='${id}';
m.style.cssText='position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);animation:snc-fade-in 0.2s ease;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
m.innerHTML=''
+'<div style="background:#1e1e3a;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px;max-width:380px;width:90%;text-align:center;animation:snc-scale-in 0.25s ease;box-shadow:0 16px 48px rgba(0,0,0,0.5);">'
+'<div style="font-size:18px;font-weight:600;color:#fff;margin-bottom:8px;">${title}</div>'
+'<div style="font-size:14px;color:rgba(255,255,255,0.55);line-height:1.5;margin-bottom:28px;">${message}</div>'
+'<div style="display:flex;gap:12px;justify-content:center;">'
+'<button id="${id}-cancel" class="snc-btn" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.8);padding:10px 24px;font-size:14px;">${cancelLabel}</button>'
+'<button id="${id}-confirm" class="snc-btn" style="background:${confirmColor};color:#fff;padding:10px 24px;font-size:14px;">${confirmLabel}</button>'
+'</div></div>';
document.body.appendChild(m);
function _cl(a){
document.removeEventListener('keydown',_onKey);
m.style.transition='opacity 0.2s ease';m.style.opacity='0';
setTimeout(function(){m.remove();},200);
try{window.sonacoveElectronAPI.ipc.send('${channel}',{action:a});}catch(e){}
}
document.getElementById('${id}-confirm').onclick=function(){_cl('confirm');};
document.getElementById('${id}-cancel').onclick=function(){_cl('cancel');};
m.onclick=function(e){if(e.target===m)_cl('cancel');};
function _onKey(e){if(e.key==='Escape'){_cl('cancel');}}
document.addEventListener('keydown',_onKey);
})();`;

    safeInject(webContents, js, `modal ${id}`);
}

/**
 * Shows a "Leave Meeting?" modal when the user tries to close the window.
 *
 * @param {Electron.WebContents} webContents - The target web contents.
 */
function showLeaveModal(webContents, strings = {}) {
    _showModal(webContents, {
        id: 'sonacove-leave-modal',
        title: strings.title,
        message: strings.message,
        confirmLabel: strings.confirm,
        confirmColor: ERROR_COLOR,
        cancelLabel: strings.cancel,
        ipcChannel: 'leave-modal-action'
    });
}

/**
 * Shows a "Meeting in Progress" modal when a deep link arrives during a meeting.
 *
 * @param {Electron.WebContents} webContents - The target web contents.
 */
function showDeeplinkModal(webContents, strings = {}) {
    _showModal(webContents, {
        id: 'sonacove-deeplink-modal',
        title: strings.title,
        message: strings.message,
        confirmLabel: strings.confirm,
        confirmColor: ERROR_COLOR,
        cancelLabel: strings.cancel,
        ipcChannel: 'deeplink-modal-action'
    });
}

// ── Toast: Info ─────────────────────────────────────────────────────────

/**
 * Shows a slide-in info toast with a title, message, and OK button.
 * Used for simple informational messages (e.g. "No updates available").
 *
 * @param {Electron.WebContents} webContents - The target web contents.
 * @param {Object} opts - Toast configuration.
 * @param {string} opts.title - Toast heading text.
 * @param {string} opts.message - Toast body text.
 * @param {'info'|'error'} [opts.type='info'] - Toast type (affects icon).
 */
function showInfoToast(webContents, opts) {
    const title = esc(opts.title);
    const message = esc(opts.message);
    const isError = opts.type === 'error';
    const iconColor = isError ? ERROR_COLOR : ACCENT;
    const iconBg = isError ? ERROR_BG : ACCENT_BG;
    const icon = svgIcon(18, iconColor, isError ? SVG_WARNING : SVG_INFO);

    const js = `(function(){
${dismissOtherToastsJS()}
${injectStylesJS()}
var t=document.createElement('div');
t.id='sonacove-info-toast';
t.style.cssText=${JSON.stringify(TOAST_CSS)};
t.innerHTML=''
+'<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;">'
+'<div style="width:36px;height:36px;border-radius:8px;background:${iconBg};display:flex;align-items:center;justify-content:center;flex-shrink:0;">'
+'${icon}'
+'</div>'
+'<div style="flex:1;min-width:0;">'
+'<div style="font-weight:600;font-size:14px;margin-bottom:2px;color:#2d2d3a;">${title}</div>'
+'<div style="font-size:13px;color:#8a8a9a;line-height:1.4;">${message}</div>'
+'</div></div>'
+'<div style="display:flex;gap:8px;justify-content:flex-end;">'
+'<button id="snc-info-ok" class="snc-btn" style="background:${ACCENT};color:#fff;">${esc(opts.okLabel)}</button>'
+'</div>';
document.body.appendChild(t);
function _dism(){
${slideOutJS('t')}
}
document.getElementById('snc-info-ok').onclick=_dism;
})();`;

    safeInject(webContents, js, 'info toast');
}

// ── Toast: About Panel ──────────────────────────────────────────────────

/**
 * Shows a slide-in About panel with app name, version, and system info.
 *
 * @param {Electron.WebContents} webContents - The target web contents.
 * @param {Object} info - App information.
 * @param {string} info.appName - Application name.
 * @param {string} info.appVersion - Application version.
 * @param {string} info.electronVersion - Electron version.
 * @param {string} info.chromeVersion - Chrome version.
 * @param {string} info.nodeVersion - Node.js version.
 * @param {string} info.platform - Platform string (e.g. "win32 x64").
 */
function showAboutPanel(webContents, info, strings = {}) {
    const appName = esc(info.appName);
    const appVersion = esc(info.appVersion);
    const electronVersion = esc(info.electronVersion);
    const chromeVersion = esc(info.chromeVersion);
    const nodeVersion = esc(info.nodeVersion);
    const platform = esc(info.platform);
    const icon = svgIcon(24, '#fff', SVG_INFO);

    const js = `(function(){
${dismissOtherToastsJS()}
${injectStylesJS()}
var t=document.createElement('div');
t.id='sonacove-about-panel';
t.style.cssText=${JSON.stringify(TOAST_CSS + 'padding:24px;')};
t.innerHTML=''
+'<div style="position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,${ACCENT},${ACCENT_HOVER});"></div>'
+'<div style="text-align:center;margin-bottom:18px;padding-top:4px;">'
+'<div style="width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,${ACCENT},${ACCENT_HOVER});margin:0 auto 12px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(244,81,30,0.3);">'
+'${icon}'
+'</div>'
+'<div style="font-weight:700;font-size:17px;color:#2d2d3a;margin-bottom:3px;">${appName}</div>'
+'<div style="font-size:13px;color:#8a8a9a;">${esc(strings.version)}</div>'
+'</div>'
+'<div style="background:#f8f8fa;border:1px solid #f0f0f2;border-radius:10px;padding:12px 14px;margin-bottom:18px;">'
+'<div style="display:flex;justify-content:space-between;font-size:12px;color:#8a8a9a;margin-bottom:8px;"><span>${esc(strings.electron)}</span><span style="color:#2d2d3a;font-weight:500;">${electronVersion}</span></div>'
+'<div style="display:flex;justify-content:space-between;font-size:12px;color:#8a8a9a;margin-bottom:8px;"><span>${esc(strings.chrome)}</span><span style="color:#2d2d3a;font-weight:500;">${chromeVersion}</span></div>'
+'<div style="display:flex;justify-content:space-between;font-size:12px;color:#8a8a9a;margin-bottom:8px;"><span>${esc(strings.node)}</span><span style="color:#2d2d3a;font-weight:500;">${nodeVersion}</span></div>'
+'<div style="display:flex;justify-content:space-between;font-size:12px;color:#8a8a9a;"><span>${esc(strings.platform)}</span><span style="color:#2d2d3a;font-weight:500;">${platform}</span></div>'
+'</div>'
+'<div style="display:flex;align-items:center;justify-content:space-between;">'
+'<span style="font-size:11px;color:#b0b0b8;">${esc(strings.copyright)}</span>'
+'<button id="snc-about-ok" class="snc-btn" style="background:${ACCENT};color:#fff;">${esc(strings.ok)}</button>'
+'</div>';
document.body.appendChild(t);
function _dism(){
${slideOutJS('t')}
}
document.getElementById('snc-about-ok').onclick=_dism;
})();`;

    safeInject(webContents, js, 'about panel');
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
    showUpdateToast,
    showLeaveModal,
    showDeeplinkModal,
    showInfoToast,
    showAboutPanel
};
