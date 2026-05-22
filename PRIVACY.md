StreamLoom Privacy Policy

Data collection

StreamLoom does not collect, store, or transmit personal data to any server operated by the developer.

What the extension does

- Detects HLS playlist URLs (m3u8) associated with the current tab
- Downloads media segments from the same sites you use and remuxes them to MP4 locally
- Saves the resulting MP4 to your device

Network access

All network requests are made directly from the extension to the video host(s) you are viewing in your browser, solely to download the selected HLS playlist and its media segments. No analytics, tracking, or telemetry is sent to the developer.

Permissions rationale

- webRequest: detect m3u8 requests initiated by the current tab
- scripting: optionally scan the page HTML for m3u8 URLs when automatic detection misses
- downloads: save the generated MP4 to your Downloads folder
- offscreen: run local remuxing in an offscreen document
- tabs/activeTab: identify the active tab and its URL for “open tab” and request-scoping

DRM

DRM-protected content is not supported.

Contact

Hunkydory Studio
https://hunkydory.studio
