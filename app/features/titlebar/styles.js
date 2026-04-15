/**
 * CSS for the custom in-page title bar (Windows).
 */
/* eslint-disable max-len */
const TITLEBAR_CSS = ''
    + '#sonacove-titlebar{position:fixed;top:0;left:0;right:0;height:32px;background:#1A1A1A;'
    + 'border-bottom:2px solid;border-image:linear-gradient(90deg,#E8613C,#F59E0B) 1;'
    + '-webkit-app-region:drag;display:flex;align-items:center;padding:0 12px;z-index:2147483647;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;'
    + 'color:#c0c0c0;user-select:none;box-sizing:border-box;}'
    + '#sonacove-titlebar .stb-icon{width:20px;height:20px;margin-right:8px;background-size:contain;'
    + 'background-repeat:no-repeat;background-position:center;}'
    + '#sonacove-titlebar .stb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
    + '#sonacove-titlebar .stb-ver{font-size:10px;color:#555566;margin-left:4px;margin-right:auto;}'
    + '#sonacove-titlebar .stb-ver.stb-update{color:#4CAF50;font-weight:600;cursor:pointer;-webkit-app-region:no-drag;'
    + 'background:#1A2E1A;border:1px solid #4CAF50;border-radius:10px;padding:2px 8px;font-size:10px;'
    + 'transition:background 0.15s ease,color 0.15s ease;margin-left:8px;}'
    + '#sonacove-titlebar .stb-ver.stb-update:hover{background:#2A3E2A;color:#66BB6A;border-color:#66BB6A;}'
    + '#sonacove-titlebar .stb-update-dot{width:5px;height:5px;border-radius:50%;background:#4CAF50;display:inline-block;margin-right:4px;vertical-align:middle;}'
    + '#sonacove-titlebar .stb-menu{display:flex;gap:2px;-webkit-app-region:no-drag;}'
    + '#sonacove-titlebar .stb-btn{background:transparent;border:none;color:#a0a0a0;cursor:pointer;'
    + 'padding:4px 10px;border-radius:4px;font-size:12px;font-family:inherit;line-height:1;'
    + 'transition:background 0.15s ease,color 0.15s ease;}'
    + '#sonacove-titlebar .stb-btn:hover{background:rgba(255,255,255,0.1);color:#fff;}'
    + '#sonacove-titlebar .stb-btn:active{background:rgba(255,255,255,0.18);color:#fff;}'
    + '#sonacove-titlebar .stb-wc{display:flex;-webkit-app-region:no-drag;margin-left:8px;}'
    + '#sonacove-titlebar .stb-wc-btn{background:transparent;border:none;color:#9090A0;cursor:pointer;'
    + 'width:46px;height:30px;display:flex;align-items:center;justify-content:center;'
    + '-webkit-app-region:no-drag;transition:background 0.15s ease,color 0.15s ease;}'
    + '#sonacove-titlebar .stb-wc-btn svg{pointer-events:none;}'
    + '#sonacove-titlebar .stb-wc-btn:hover{background:rgba(255,255,255,0.08);color:#D0D0DA;}'
    + '#sonacove-titlebar .stb-wc-btn:active{background:rgba(255,255,255,0.14);color:#E0E0E6;}'
    + '#sonacove-titlebar .stb-wc-btn.stb-close:hover{background:#e81123;color:#fff;}'
    + 'body::-webkit-scrollbar{width:8px;}'
    + 'body::-webkit-scrollbar-track{background:transparent;}'
    + 'body::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:4px;}'
    + 'body::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.3);}';

/**
 * CSS for the macOS titlebar content area.
 * Positioned to the right of native traffic lights (hiddenInset mode).
 * NOTE: left:78px depends on trafficLightPosition {x:12} in main.js — update both together.
 */
const MAC_TITLEBAR_CSS = ''
    + '#sonacove-mac-titlebar{position:fixed;top:0;left:0;right:0;height:28px;'
    + 'background:#1A1A1A;'
    + '-webkit-app-region:drag;z-index:2147483647;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;font-size:12px;'
    + 'color:#c0c0c0;user-select:none;box-sizing:border-box;}'
    + '#sonacove-mac-titlebar .stb-content{position:absolute;left:50%;top:50%;'
    + 'transform:translate(-50%,-50%);display:flex;align-items:center;gap:6px;}'
    + '#sonacove-mac-titlebar .stb-icon{width:16px;height:16px;background-size:contain;'
    + 'background-repeat:no-repeat;background-position:center;}'
    + '#sonacove-mac-titlebar .stb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
    + 'font-size:12px;font-weight:500;color:#D0D0DA;}'
    + '#sonacove-mac-titlebar .stb-ver{font-size:10px;color:#555566;}'
    + '#sonacove-mac-titlebar .stb-ver.stb-update{color:#4CAF50;font-weight:600;cursor:pointer;-webkit-app-region:no-drag;'
    + 'background:#1A2E1A;border:1px solid #4CAF50;border-radius:10px;padding:2px 8px;font-size:10px;'
    + 'transition:background 0.15s ease,color 0.15s ease;margin-left:4px;}'
    + '#sonacove-mac-titlebar .stb-ver.stb-update:hover{background:#2A3E2A;color:#66BB6A;border-color:#66BB6A;}'
    + '#sonacove-mac-titlebar .stb-update-dot{width:5px;height:5px;border-radius:50%;background:#4CAF50;'
    + 'display:inline-block;margin-right:4px;vertical-align:middle;}';

module.exports = { TITLEBAR_CSS, MAC_TITLEBAR_CSS };
