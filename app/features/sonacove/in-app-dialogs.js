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
        + `_s.textContent='${SHARED_STYLES}';`
        + `document.head.appendChild(_s);}`;
}

/**
 * Shows a slide-in toast notification for a downloaded app update.
 *
 * @param {Electron.WebContents} webContents - The target web contents.
 * @param {string} version - The new version number.
 */
function showUpdateToast(webContents, version) {
    const v = String(version).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const js = `(function(){
var old=document.getElementById('sonacove-update-toast');if(old)old.remove();
${injectStylesJS()}
var t=document.createElement('div');
t.id='sonacove-update-toast';
t.style.cssText='position:fixed;top:48px;right:16px;z-index:999999;width:320px;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:16px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#2d2d3a;box-shadow:0 4px 24px rgba(0,0,0,0.12);animation:snc-slide-in 0.35s ease forwards;overflow:hidden;';
t.innerHTML=''
+'<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;">'
+'<div style="width:36px;height:36px;border-radius:8px;background:rgba(244,81,30,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;">'
+'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F4511E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
+'</div>'
+'<div style="flex:1;min-width:0;">'
+'<div style="font-weight:600;font-size:14px;margin-bottom:2px;color:#2d2d3a;">Update Ready</div>'
+'<div style="font-size:13px;color:#8a8a9a;line-height:1.4;">Version ${v} is ready to install.</div>'
+'</div></div>'
+'<div style="display:flex;gap:8px;justify-content:flex-end;">'
+'<button id="snc-toast-later" class="snc-btn" style="background:#fff;border:1px solid #e0e0e0;color:#5a5a6a;">Later</button>'
+'<button id="snc-toast-install" class="snc-btn" style="background:#F4511E;color:#fff;">Install Now</button>'
+'</div>'
+'<div style="position:absolute;bottom:0;left:0;height:3px;background:rgba(244,81,30,0.35);animation:snc-progress 15s linear forwards;border-radius:0 0 0 12px;"></div>';
document.body.appendChild(t);
var _tm=setTimeout(function(){_dism();},15000);
function _dism(){
clearTimeout(_tm);
t.style.transition='transform 0.3s ease,opacity 0.3s ease';
t.style.transform='translateX(120%)';t.style.opacity='0';
setTimeout(function(){t.remove();},300);
try{window.sonacoveElectronAPI.ipc.send('update-toast-action',{action:'dismiss'});}catch(e){}
}
document.getElementById('snc-toast-install').onclick=function(){
clearTimeout(_tm);t.remove();
try{window.sonacoveElectronAPI.ipc.send('update-toast-action',{action:'install'});}catch(e){}
};
document.getElementById('snc-toast-later').onclick=_dism;
})();`;

    try {
        webContents.executeJavaScript(js);
    } catch (err) {
        console.warn('Failed to show update toast:', err.message);
    }
}

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
    const esc = str => String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const { id, confirmColor } = opts;
    const title = esc(opts.title);
    const message = esc(opts.message);
    const confirmLabel = esc(opts.confirmLabel);
    const cancelLabel = esc(opts.cancelLabel);
    const channel = esc(opts.ipcChannel);

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
m.style.transition='opacity 0.2s ease';m.style.opacity='0';
setTimeout(function(){m.remove();},200);
try{window.sonacoveElectronAPI.ipc.send('${channel}',{action:a});}catch(e){}
}
document.getElementById('${id}-confirm').onclick=function(){_cl('confirm');};
document.getElementById('${id}-cancel').onclick=function(){_cl('cancel');};
m.onclick=function(e){if(e.target===m)_cl('cancel');};
function _onKey(e){if(e.key==='Escape'){document.removeEventListener('keydown',_onKey);_cl('cancel');}}
document.addEventListener('keydown',_onKey);
})();`;

    try {
        webContents.executeJavaScript(js);
    } catch (err) {
        console.warn(`Failed to show modal ${id}:`, err.message);
    }
}

/**
 * Shows a "Leave Meeting?" modal when the user tries to close the window.
 *
 * @param {Electron.WebContents} webContents - The target web contents.
 */
function showLeaveModal(webContents) {
    _showModal(webContents, {
        id: 'sonacove-leave-modal',
        title: 'Leave Meeting?',
        message: 'You are currently in a meeting. Are you sure you want to leave?',
        confirmLabel: 'Leave',
        confirmColor: '#e74c3c',
        cancelLabel: 'Stay',
        ipcChannel: 'leave-modal-action'
    });
}

/**
 * Shows a "Meeting in Progress" modal when a deep link arrives during a meeting.
 *
 * @param {Electron.WebContents} webContents - The target web contents.
 */
function showDeeplinkModal(webContents) {
    _showModal(webContents, {
        id: 'sonacove-deeplink-modal',
        title: 'Meeting in Progress',
        message: 'You are already in a meeting. Do you want to leave and join a new one?',
        confirmLabel: 'Leave Meeting',
        confirmColor: '#e74c3c',
        cancelLabel: 'Stay',
        ipcChannel: 'deeplink-modal-action'
    });
}

module.exports = { showUpdateToast, showLeaveModal, showDeeplinkModal };
