# Sonacove Meets for Windows: Tauri preview

A test build of the new Windows desktop app (Tauri / WebView2), for trying it
out. It is **not a release**: the app's updater never looks at this branch,
and nothing installed from the Store or the release feed changes.

**Download** (build 2: camera and microphone fixed): [Sonacove-Meets-Tauri-preview.zip](https://github.com/alfaz-studio/sonacove-electron/raw/tauri-preview/Sonacove-Meets-Tauri-preview.zip)

1. Unzip it anywhere and double-click `Sonacove Meets.exe`. There is no installer.
2. Windows shows "Windows protected your PC" because the preview is not
   code-signed: click **More info**, then **Run anyway**.
3. Sign in with your Sonacove account and join a meeting as usual.

Needs 64-bit Windows 10 (21H2 or newer) or Windows 11. It uses the live
sonacove.com service. Logs for bug reports are in
`%LOCALAPPDATA%\com.sonacove.meet\logs`.

SHA-256 of the zip: `c0ea58206bc1ac4df2776cec4dbd727c91412f3133ae9f3d46b526c803fd9dc0`
