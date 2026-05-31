StreamLoom

Short description:
Find HLS (m3u8) streams on the current page, pick a quality, and download an MP4 locally.

Overview:
StreamLoom helps you detect HLS playlists (m3u8) used by a video on the current page. After you select a stream and a quality variant, StreamLoom downloads the playlist segments and remuxes them into an MP4 on your machine.

Single purpose:
StreamLoom helps the user to save a video that is delivered via HLS (m3u8) on the current page as a local MP4 file. The extension only discovers HLS playlist URLs for the page you are viewing, downloads the playlist’s media segments, and remuxes them locally into a single MP4.

Made by Hunkydory Studio
https://hunkydory.studio

Important notes:
- DRM-protected streams are not supported.
- Download only content you have the rights to download.
- Very large videos may fail due to browser/extension memory limits.

How to use:
1. Open a page with an HLS video and start playback.
2. Open StreamLoom.
3. Select a detected stream and quality.
4. Click Download MP4.

Permissions justification:
StreamLoom needs a small set of permissions to (1) discover HLS playlists used by the page you are viewing and (2) save the resulting MP4 to your device. All processing happens locally in your browser. StreamLoom does not send browsing data, video URLs, or downloads to the developer.

- webRequest: used to observe completed network requests made by tabs so the extension can detect HLS playlist URLs (m3u8). StreamLoom only looks at the request URL to identify m3u8 traffic; it does not block, redirect, or modify requests. Detected m3u8 URLs are kept only in memory per tab and are removed when the tab is closed or you click “Clear”.
- declarativeNetRequest: used to modify outgoing request headers (injecting the correct Referer and Origin) when fetching HLS playlists, decryption keys, and media segments. Many HLS streaming servers protect stream access by blocking requests that lack matching referer headers corresponding to the video hosting site. Because modern browsers forbid setting the Referer header programmatically in standard fetch() calls, declarativeNetRequest is the only secure and Manifest V3-compliant way to dynamically inject these headers so that streams can be downloaded and remuxed locally.
- host permissions (*://*/*): HLS playlists and media segments are often served from many different domains and CDNs, and the domain cannot be known ahead of time. This permission allows StreamLoom to (a) see m3u8 requests regardless of which host serves them and (b) fetch the playlist/segment files directly from the site/CDN you are already visiting in order to build the MP4. StreamLoom does not run in the background to crawl sites; it only operates in response to your interaction (opening the popup, scanning a page, or starting a download).
- scripting: used only when you click “Scan page”. StreamLoom injects a small script into the current tab (and its frames) to search the page HTML and inline scripts for m3u8 URLs in cases where the playlist URL is not easily discoverable via network detection. This scan does not read passwords or form fields; it only looks for URL-like strings that end in .m3u8 and returns the matches to the extension.
- downloads: used to save the final MP4 file through the browser’s download manager. The download is visible in Chrome’s Downloads UI and follows your browser’s download settings.
- offscreen: used to run the FFmpeg WebAssembly remuxing step in an offscreen document (required in Manifest V3 for long-running/local processing). This is used to combine downloaded HLS segments into a single MP4 locally, without uploading the video anywhere.
- storage: used to temporarily store discovered HLS playlists and active download progress metrics in memory via `chrome.storage.session`. This allows the extension to maintain state and synchronize progress updates seamlessly with the user popup interface even if the ephemeral background service worker is recycled or goes to sleep during download.
- tabs and activeTab: used to identify the active tab the user is on (so the extension knows which page’s streams to show), and to support UI actions like focusing the current page when you click “Open source tab”. StreamLoom does not read your browsing history.

Remote code:
StreamLoom does not download and execute remote code. All executable extension code (JavaScript/HTML/CSS) and the FFmpeg WebAssembly files are packaged with the extension. StreamLoom does fetch remote content from the site you are viewing (HLS playlists and media segments) as input data for the download/remux process, but it does not treat that content as executable code.

Privacy:
StreamLoom does not send data to the developer. It only requests video playlists and segments directly from the site you are viewing in order to create the MP4. See PRIVACY.md for the full policy text.
