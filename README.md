# StreamLoom (Chrome Extension)

This repository builds a Manifest V3 Chrome extension that:

- Detects `.m3u8` requests made by the current tab (plus an optional HTML scan)
- Lets you pick the quality from a master playlist
- Downloads the HLS segments and remuxes them to MP4 locally using `ffmpeg.wasm`

## Build

```bash
npm install
npm run build
```

The unpacked extension output is in:

- `StreamLoom/`

## Install (Unpacked)

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click “Load unpacked”
4. Select the `StreamLoom/` folder

## Use

1. Open a page with an HLS video
2. Start playback (this is what usually triggers `.m3u8` requests)
3. Open the extension popup
4. Pick a stream under “Found streams”
5. Pick a “Quality”
6. Click “Download MP4”

The MP4 is saved to your Downloads folder.

If Chrome prompts you to grant site access, allow it for the current site so the extension can fetch the playlist/segments.

## Web Store

- Draft listing text: `WEBSTORE_LISTING.md`
- Privacy policy text: `PRIVACY.md`
- Third-party notices: `THIRD_PARTY_NOTICES.md`

## Notes / Limitations

- DRM-protected streams cannot be downloaded this way.
- This approach downloads all segments into memory (inside the extension) before producing the MP4. Very large videos can fail or crash due to memory limits.
- Some sites require special request headers/tokens beyond cookies; those playlists may not be fetchable from an extension.
- If the video is already MP4 (not HLS), there may be no `.m3u8` to detect.
