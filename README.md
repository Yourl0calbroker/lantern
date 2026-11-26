# Lantern

Lantern is a native Kotlin/Jetpack Compose Android client for a PC-hosted SillyTavern and KoboldCpp setup. It is not a WebView wrapper, PWA, or second inference engine. SillyTavern stays authoritative for characters, chats, lorebooks, presets, settings, prompts, and generation.

**Current releases:** Android `1.5.3` (tag `App`) · Bridge `1.1.2` (tag `WebApp`) · Verified with SillyTavern `1.19.1`.

## Contents

- [Project status](#project-status)
- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Using Lantern](#using-lantern)
- [Updates](#updates)
- [Security and data handling](#security-and-data-handling)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Support](#support)

## Project status

Lantern Android `1.5.3` is usable for day-to-day chat with a running SillyTavern bridge. The release and debug APKs are built and signed, and an in-place `1.5.1 → 1.5.2` OTA was previously verified on device with pairing, token, preferences, and app data preserved. Version `1.5.3` fixes duplicated words during streamed replies.

Validation is live API and on-device QA; there is no automated unit or instrumentation test suite. Some deeper interactions remain unverified, including real-generation timing, web app page load, and the silent Tail Lock reconnect after a controlled network drop. Treat the project as a carefully tested beta rather than a finished, formally certified release.

The 3DS client is still in development. A build has been established, but it is a barebones proof of concept and is not ready for public release.

## Features

- **Native chat:** Compose UI with Library, Conversations, Lorebooks, Tools, and Settings. Chat remains native; WebView is used only for web apps you explicitly add.
- **PC-authoritative data:** SillyTavern and KoboldCpp own all real content. The Android cache never rewrites PC chats, characters, lorebooks, presets, or settings.
- **Authenticated bridge:** Pairing uses a one-time code from the SillyTavern panel. The Android client stores its Bearer token in the Android Keystore and fetches a CSRF token before mutations.
- **SillyTavern fidelity:** Prompt construction, lorebooks, presets, Mistral V7-Tekken formatting, DRY, XTC, Mirostat, KoboldCpp config, and generation settings stay on the PC side.
- **Generation UX:** Streaming replies, reconnect/replay buffering, animated thinking state, impersonation, and completion notifications with exact, familiar wording.
- **Polished interface:** Floating surfaces, restrained color, plain calm background, rounded controls, careful spacing, chat font/layout choices, long-press multi-select, and focus mode for both chat and web apps.
- **Web App Tool:** Add web apps with mobile viewport/user-agent by default, optional desktop mode, list/grid shelf, per-app overflow settings, and real home-screen shortcuts.
- **Media:** Music and video import, playlists, shuffle, background/loop playback, floating resizable video overlay, remembered positions, and PC-side YouTube ripping via the YT Downloader.
- **Tail Lock:** Silent, error-driven Tailscale reconnect behavior with an optional `Aggressive Lock` that is greyed out when Tail Lock is off.

## Requirements

- A PC running SillyTavern `1.19.1` or a compatible recent release, with KoboldCpp reachable from SillyTavern.
- Android `11` or newer (`minSdk 30`). Notifications require Android `13+` permission when the notification toggle is enabled.
- Phone and PC on the same private LAN, or Tailscale available on both.
- An open SillyTavern browser tab while generating from the phone. The browser tab drives ST generation.
- Git URL extension installs require SillyTavern's Extensions feature and server plugins to be available. The Lantern-aware SillyTavern endpoint performs the server-plugin sync automatically.

## Quick start

### 1. Install the Android client

Install the signed release APK from the `App` release:

<https://github.com/Yourl0calbroker/lantern/releases#release-App>

For local/package installs:

```powershell
adb install -r apks\lantern-release-1.5.3.apk
```

Debug and release builds use different application ids (`com.lantern.app.debug` and `com.lantern.app`), so they can coexist. The release build uses a local self-signed key. If Android rejects a signature change from an older install, uninstall that older release first.

### 2. Install the SillyTavern extension

In SillyTavern, open **Extensions → Install Extensions** and enter:

```text
Git URL:   https://github.com/Yourl0calbroker/lantern
Branch/tag: WebApp
```

The `WebApp` tag contains the root `manifest.json`, root `index.js`, `pc/extension/`, `pc/plugin/`, and `WEBAPP-SHA256SUMS.txt`. SillyTavern clones it into `data/<user>/extensions/lantern/`. On a Lantern-aware SillyTavern install, the endpoint then copies `pc/plugin/` into `plugins/lantern-bridge/`, enables `enableServerPlugins`, and adds private LAN/Tailscale whitelist entries.

On a stock SillyTavern install that does not have the Lantern endpoint patch, the Git URL still installs the browser extension, but you must run the local installer once from the checkout:

```powershell
powershell -ExecutionPolicy Bypass -File .\pc\install.ps1 -SillyTavernPath 'C:\Special\SillyTavern'
```

No release ZIP or PowerShell download bootstrap is required for the normal Git URL flow.

### 3. Restart and pair

1. Restart SillyTavern if it is running.
2. Hard reload the open SillyTavern tab.
3. Open **Extensions → Lantern Bridge**.
4. Copy the displayed `host:port` address and the pairing code.
5. In Lantern on Android, enter that address and code.
6. Keep the SillyTavern tab open while generating from the phone.

The panel shows a ready-to-enter LAN/Tailscale address such as `192.168.0.208:8000`. If the code expires, reopen the panel and enter the fresh code.

## Using Lantern

- **Library** loads character counts in the background and opens chats natively.
- **Conversations** groups chats by recent activity and supports favourites.
- **Lorebooks** and **Library** support long-press multi-select, checkboxes, Cancel/Delete, and confirmation.
- **Chat** supports two layouts, four font choices, authenticated avatars, impersonation, regeneration of the latest reply, and focus mode.
- **Tools** hosts the Web App Tool and media features. Web apps are the only WebView content.
- **Settings** controls auto rotate, chat text, notifications, Tail Lock, Aggressive Lock, update checks, and the links at the bottom.
- **Unpairing:** the Lantern Bridge panel shows the currently connected device and an **Unpair** action that hard-deletes that device record.

Administrative bridge endpoints are restricted to same-origin/loopback clients. Use the SillyTavern panel for admin actions rather than a LAN URL.

## Updates

### Android

Lantern's updater is pinned to the GitHub release tagged `App` in `Yourl0calbroker/lantern`. It has no pasteable repository field. It selects the release APK, verifies `SHA256SUMS.txt`, downloads to `files/updates`, requests install permission, and installs through a FileProvider. Pairing, tokens, preferences, and app data are preserved. The release page is <https://github.com/Yourl0calbroker/lantern/releases#release-App>.

### SillyTavern bridge

Use either SillyTavern's normal extension update control or the Lantern Bridge panel's **Check for update** / **Install update**. Both pull the `WebApp` Git tag and verify `WEBAPP-SHA256SUMS.txt`. The updater backs up plugin and extension directories, preserves `devices.json`, `pairing.json`, and vendored `yt_dlp*` files, and writes a restart marker. Restart SillyTavern and hard reload the browser tab after a web update.

## Security and data handling

- Pairing uses a one-time code; the Android token is stored encrypted through the Android Keystore.
- Mutations use `/csrf-token`, the session cookie, and `X-CSRF-Token`.
- Admin endpoints are loopback/same-origin only; normal LAN traffic uses authenticated plugin routes.
- Devices can be hard-unpaired from the SillyTavern panel, immediately revoking that token.
- No cloud relay is required. Connections use the PC's private LAN address or Tailscale.
- Android never overwrites authoritative PC data; mutation routes are validated and bounded.

## Repository layout

```text
manifest.json            SillyTavern Git-extension entry point
index.js                 Browser-extension entry that imports pc/extension/index.js
WEBAPP-SHA256SUMS.txt    Checksums for the Git-installable web payload
pc/extension/            SillyTavern browser extension and Lantern Bridge panel
pc/plugin/               Lantern Bridge server plugin
pc/install.ps1           Optional local/offline installer
docs/                    Architecture, API, security, compatibility, and QA notes
```

Android and 3DS builds are published as separate release tags. The `App` tag carries Android APKs and checksums; `WebApp` carries the Git-installable web payload; `3ds` is reserved for the experimental 3DS client.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Phone cannot connect | Use the exact `host:port` from the Lantern Bridge panel. Confirm the phone and PC share the LAN or Tailscale, and that SillyTavern is listening on port `8000`. |
| `403 local_only` | Administrative endpoints reject LAN requests. Use `http://127.0.0.1:8000` or the SillyTavern panel. |
| Pairing code rejected | The code is short-lived. Reopen **Extensions → Lantern Bridge** and enter the fresh code. |
| Bridge panel missing | Hard reload the SillyTavern tab, confirm the Lantern Bridge extension is enabled, then restart SillyTavern. |
| Update says up to date | The version and `WebApp` commit already match. After a tag change, restart SillyTavern and reload the tab. |
| Web update applied but behavior is old | Server plugin code loads only on startup. Restart SillyTavern after the restart marker appears. |
| YouTube ripping cannot find `yt_dlp` | Install the vendored wheel into the PC Python environment used by the plugin, or set `LANTERN_YTDLP_MODULE` to an importable `yt_dlp` module. |
| Notifications do not appear | On Android 13+, grant the notification permission when prompted and keep the in-app notification toggle enabled. |

## Support

- **Report A Bug:** <https://github.com/Yourl0calbroker/lantern/issues>
- **Feature Request:** <https://github.com/Yourl0calbroker/lantern/discussions>
- **Ko-fi:** <https://ko-fi.com/lonesniper14>

# Disclaimer

lantern is an independent, unofficial client and is not affiliated with, endorsed by, or officially connected to the SillyTavern project or its developers. "SillyTavern" is used strictly to describe compatibility with user-hosted SillyTavern instances. Users are responsible for providing and managing their own SillyTavern server connections.

# License & Copyright

Copyright (c) 2026 Yourl0calbroker. All Rights Reserved.
This software and its source code are proprietary. No part of this repository may be copied, modified, distributed, or used without the express written permission of the copyright holder.
