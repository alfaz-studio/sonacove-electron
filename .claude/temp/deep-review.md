# Deep Review: PR #112 — chore/cleanup-unused

Reviewed: 20 files (all surviving changed/new files), ~16,800 lines of diff

## CRITICAL (must fix before merge)

### [CRITICAL] `new-window` event handler is dead code on Electron 40 — main.js:987

The `setupChildWindowIcon` function at line 970 registers a `contents.on('new-window', ...)` listener. The `new-window` event was deprecated in Electron 13 and **does not fire** in Electron 40. This means child windows opened via `window.open()` from the remote web app will NOT receive the custom icon via this code path.

The `setWindowOpenHandler` on line 976 still works, but the `new-window` listener on line 987 is dead code that will never execute. The `icon` set in `overrideBrowserWindowOptions` on line 980 is the only effective path.

**Impact**: The dead listener itself doesn't cause a runtime error, but it creates a false impression that both paths set the icon. If the `setWindowOpenHandler` path is ever removed, icons would silently break.

**Suggested fix**: Remove the `contents.on('new-window', ...)` block (lines 987-989). Keep only the `setWindowOpenHandler` path.

### [CRITICAL] Deep-link IPC listener leak and race condition — app/features/deep-link.js:89-93

When a deep link arrives during a meeting, `navigateDeepLink` shows a modal and awaits a one-time IPC response:

```js
const action = await new Promise(resolve => {
    ipcMain.once('deeplink-modal-action', (_event, data) => {
        resolve(data?.action);
    });
});
```

**Problem 1 — Stale listener**: If the user dismisses the modal by clicking the backdrop or pressing Escape, the `_showModal` code in `in-app-dialogs.js` sends the IPC message with `{action:'cancel'}`, which resolves the Promise. However, if the user closes the Electron window or navigates away before responding, the `ipcMain.once` listener is never triggered and the Promise never resolves — the `navigateDeepLink` call hangs forever. The listener persists until the next deep link modal response.

**Problem 2 — Listener stacking**: If two deep links arrive in rapid succession while in a meeting, two `ipcMain.once('deeplink-modal-action', ...)` listeners are registered. The in-app modal is replaced (old one removed), but only one IPC message is sent. The first listener consumes it; the second listener persists indefinitely, waiting for a message that never comes.

**Suggested fix**: Add a timeout to the Promise (e.g., 60s) and clean up the listener on timeout. Alternatively, remove any existing `deeplink-modal-action` listener before registering a new one.

## PROBLEM (should fix)

### [PROBLEM] Stale comment references deleted file — main.js:69

```js
// For enabling remote control, please change the ENABLE_REMOTE_CONTROL flag in
// app/features/conference/components/Conference.js to true as well
```

`app/features/conference/components/Conference.js` was deleted in this PR. The comment is now misleading — someone following these instructions would be confused.

**Suggested fix**: Update the comment to reflect the new architecture. If remote control is no longer supported (the renderer app is gone), remove the `ENABLE_REMOTE_CONTROL` flag and its associated code (`setupRemoteControlMain` on line 838) entirely.

### [PROBLEM] Unused `getTranslations` import — main.js:30

```js
const { initI18n, t, getTranslations } = require('./app/features/i18n');
```

`getTranslations` is imported but never used anywhere in `main.js`. Dead import.

**Suggested fix**: Remove `getTranslations` from the destructured import.

### [PROBLEM] Leftover devDependencies: `@babel/core` and `@babel/eslint-parser` — package.json:106-107

The `.eslintrc.js` was updated to remove the `@babel/eslint-parser` parser and `@babel/preset-react` options. However, both `@babel/core` and `@babel/eslint-parser` remain in `devDependencies`:

```json
"@babel/core": "^7.17.8",
"@babel/eslint-parser": "^7.17.0",
```

Neither is referenced anywhere in the codebase (no webpack babel-loader, no eslint babel parser). These are dead dependencies that should have been removed with the other 39 deps.

**Suggested fix**: Remove both from `devDependencies` and re-run `npm install` to update `package-lock.json`.

### [PROBLEM] `url.parse()` is deprecated — app/features/openExternalLink.js:15

```js
u = url.parse(link);
```

`url.parse()` has been deprecated since Node.js 11 in favor of `new URL()`. While webpack bundles this and it still works, it may be removed in a future Node.js/Electron version. This file was moved (not modified) in this PR, so it's an inherited issue — but since the PR is a cleanup pass, it's a good time to fix it.

**Suggested fix**: Replace with `new URL(link)` and adjust the property access (`protocol` and `href` work the same on both).

## SUGGESTION (nice to have)

### [SUGGESTION] `error.html` renders empty if `strings` query param is missing — app/error.html:102-104

The error page now reads all text from the `i18n` object parsed from query params:

```js
heading.textContent = i18n.heading;
subtitle.textContent = i18n.subtitle;
retryBtn.textContent = i18n.retryButton;
```

If the `strings` param is missing or malformed (JSON parse fails), all three elements show `undefined` as text. The old version had hardcoded fallback strings. While this is unlikely in practice (the `did-fail-load` handler always passes `strings`), a defensive fallback would be safer.

**Suggested fix**: Add fallback values: `heading.textContent = i18n.heading || 'Unable to connect';`

### [SUGGESTION] `openExternalLink.js` uses ES module `export` syntax in a CommonJS project — app/features/openExternalLink.js:11

```js
export function openExternalLink(link) {
```

The rest of the codebase uses `module.exports = { ... }`. This works because webpack converts it, but it's inconsistent with every other file in the project which uses CommonJS.

**Suggested fix**: Convert to `module.exports = { openExternalLink };` for consistency with the rest of the codebase.

### [SUGGESTION] `ipcMain.removeAllListeners` on `closed` could be fragile — main.js:943-945

The comment on line 939 acknowledges this:

```js
// Safe to use removeAllListeners here because each channel has exactly
// one listener registered during this window's lifecycle.
```

This is fine today but fragile. If another feature ever registers a listener on `retry-load`, `update-toast-action`, or `leave-modal-action`, `removeAllListeners` would silently remove it too. Storing handler references and calling `ipcMain.removeListener()` would be more robust.

### [SUGGESTION] Consider cleaning up the staging banner CSS pattern in `patchMainJs` — staging-launcher/lib/patching.js:160-169

The staging banner regex patterns match against compiled CSS output, which is inherently fragile (webpack/terser can change formatting at any time). The `tryReplace` helper logs a warning when patterns don't match, which is good. But since the main app's staging banner CSS was refactored in this PR (changed from full-width bar to bottom-right pill), the compiled patterns in `patchMainJs` may need updating to match the new CSS.

**Impact**: If the patterns no longer match, `tryReplace` will warn but the staging launcher will launch with the app's own small pill — which is actually the desired layout now. The patcher's resize might be redundant.

**Suggested fix**: Verify the patcher patterns still match against the new compiled output. If the app's own CSS is already a small pill, the patcher rules can be removed.

## Summary

- 2 critical, 4 problems, 4 suggestions
- **Key themes**:
  - Dead code from the cleanup that wasn't fully cleaned up (stale comment, unused import, leftover devDeps, dead `new-window` listener)
  - The deep-link modal IPC pattern has a genuine listener leak and potential hang
  - The `error.html` i18n refactor lost its hardcoded fallbacks
  - The `openExternalLink.js` module syntax is inconsistent with the project convention
