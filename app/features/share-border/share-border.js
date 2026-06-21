// Recolour the frame live from host theme tokens pushed by main. The preload
// bridge (share-border-preload.js) exposes window.shareBorderAPI. Externalised
// from share-border.html so the page can use a strict `script-src 'self'` CSP
// (no inline-script allowance) — mirrors the controls-bar renderer script.
(() => {
    const api = window.shareBorderAPI;

    if (api && typeof api.onTheme === 'function') {
        api.onTheme(theme => {
            if (theme && theme.accent) {
                document.documentElement.style.setProperty('--sb-color', theme.accent);
            }
        });
    }
})();
