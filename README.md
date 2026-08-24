# WidevineProxy2
An extension-based proxy for Widevine EME challenges and license messages. \
Modifies the challenge before it reaches the web player and retrieves the decryption keys from the response.

## Features
+ User-friendly / GUI-based
+ Bypasses one-time tokens, hashes, and license wrapping
+ JavaScript native Widevine implementation
+ Supports Widevine Device files
+ Manifest V3 compliant

## Widevine Devices
This addon requires a Widevine Device file to work, which is not provided by this project.
+ Use an existing Remote CDM like [this one](https://github.com/user-attachments/files/21834836/remote.json)
+ Follow [this](https://forum.videohelp.com/threads/408031) guide if you want to dump your own device.
+ Ready-to-use Widevine Devices can be found on the [VideoHelp forum](https://forum.videohelp.com/forums/48).

## Compatibility
+ Compatible (tested) browsers: Firefox/Chrome on Windows/Linux.
+ Works with any service that accepts challenges from Android devices on the same endpoint.

## Playwright channel health monitoring

The repository includes a monitoring-only Playwright command for checking the SKY GO section on StreamNinja. It discovers the watch-page cards, finds the configured channel sources, clicks the matching source to start playback, and records whether a DASH manifest and initialized video element were observed. By default, `PLAYER_MODE=default` leaves the site's current player (normally Bitmovin) untouched. Set `PLAYER_MODE=shaka` only when a Shaka-specific comparison is required. The source click is authoritative and the monitor waits up to 90 seconds by default. The separate Play control is disabled unless `PLAY_FALLBACK_ENABLED=true`; when enabled, it is only used after `PLAY_FALLBACK_DELAY_MS`.

By default the monitor does not load the extension interception code, use a WVD or remote CDM, or extract keys. It does include the final playable MPD URL in `manifest.fileName` so an authenticated receiver can synchronize that URL to a channel database. Treat reports and workflow artifacts as sensitive because MPD URLs can contain query-string credentials.

For DRM diagnostics, the report includes passive lifecycle counters such as the requested key-system name, media-key sessions created, license challenges generated, and successful session updates. It never reads or stores challenge bodies, license bodies, KIDs, or content keys — unless key extraction is enabled (see below).

### Optional: local Widevine (WVD) key extraction

When `EXTRACT_KEYS=true`, the monitor performs the same man-in-the-middle that the browser extension does, but with your **local** `.wvd` device instead of the extension service worker. It re-signs the EME license challenge with your device key (via a `page.exposeFunction` bridge to `automation/key-extractor.js`, which ports `lib/cdm.js` + `lib/device.js`), captures the returned license, and decrypts the content keys. Each channel result then carries `keys: [{ kid, k, keyString }]` (key id vs key value, `keyString` is the `--key kid:k` form your backend understands) plus `pssh`. PSSH is taken from the license-challenge init data, so the report never includes the manifest body.

Because the challenge is re-signed for your device, the headless browser's own playback will usually **not** decrypt — that is expected: the goal is key capture, not a healthy-playback signal. Keep `FAIL_ON_UNHEALTHY=false` for extraction runs.

Provide the device as base64 (it is never committed):

```
base64 -w0 "/path/to/device.wvd"        # copy the output
```

Set the secret in your environment / GitHub Actions:

```
EXTRACT_KEYS=true
WIDEVINE_DEVICE_B64=<base64 from above>
# PSSH is recovered from the license-challenge init data, so the manifest body is
# never captured or reported. No separate flag is needed.
```

Manifest reporting prefers the successful response after redirects. It records the host, final HTTP status, full MPD URL in `fileName`, and a non-reversible URL fingerprint.

### Local setup

Requirements:

- Node.js 20 or newer
- Google Chrome, with Playwright Chromium as a fallback

Install the dependencies and Playwright browser support:

```shell
npm install
npx playwright install chromium
```

The monitor automatically loads `.env` from the repository root when it exists. `.env.example` is only a committed template and is never read as configuration. Shell and GitHub Actions environment variables take precedence over values in `.env`. `TARGET_STREAM_URL` defaults to `https://streamcorner.st/skygo`, and `TARGET_CHANNELS` defaults to ESPN NZ, ESPN 2 NZ, Sky Sport 1-9 NZ, and Sky Sport Select NZ.

Set `HEADLESS=false` in `.env` to display the automated browser locally.

Card discovery retries the home page when the SKY GO section has not populated. `DISCOVERY_MAX_PASSES` controls polling and scrolling per attempt, while `DISCOVERY_RETRIES` controls complete home-page reload attempts. An empty section is reported as a discovery error instead of incorrectly marking every channel `not_found`.

Run the monitor:

```shell
npm run monitor
```

The report is written to `artifacts/channel-health.json` by default. It contains one entry per requested channel:

```json
{
  "channel": "SKY SPORT 7 NZ",
  "status": "healthy",
  "manifest": {
    "available": true,
    "type": "DASH",
    "fileName": "https://media.example/live/manifest.mpd?token=example",
    "host": "media.example",
    "httpOk": true,
    "status": 200
  },
  "playback": {
    "initialized": true,
    "videoElements": 1,
    "videoErrors": []
  }
}
```

Set `HEALTH_REPORT_ENDPOINT` to POST the same JSON report to an HTTPS endpoint. `HEALTH_REPORT_TOKEN` is sent as a bearer token and should be required by the receiving server. `FAIL_ON_UNHEALTHY=true` makes the command return a failure status when any requested channel is not healthy.

### GitHub Actions

The `Channel health monitor` workflow runs every six hours and can also be started manually. Each run uploads `channel-health.json` as a 14-day workflow artifact.

For database synchronization, set `HEALTH_REPORT_ENDPOINT` to `https://your-server.example/api/channel-health/report` and set `HEALTH_REPORT_TOKEN` to the same long random value configured as `CHANNEL_HEALTH_REPORT_TOKEN` on the Laravel server. `PLAYWRIGHT_STORAGE_STATE_BASE64` remains optional. `TARGET_CHANNELS` can be overridden with a repository variable containing a comma-separated list. Device files, `remote.json`, storage state, local reports, and environment files remain ignored by Git.

## Installation
+ Chrome
  1. Download the ZIP file from the [releases section](https://github.com/DevLARLEY/WidevineProxy2/releases)
  2. Navigate to `chrome://extensions/`
  3. Enable `Developer mode`
  4. Drag-and-drop the downloaded file into the window
+ Firefox
  + Persistent installation
    1. Download the XPI file from the [releases section](https://github.com/DevLARLEY/WidevineProxy2/releases)
    2. Navigate to `about:addons`
    3. Click the settings icon and choose `Install Add-on From File...`
    4. Select the downloaded file
  + Temporary installation
    1. Download the ZIP file from the [releases section](https://github.com/DevLARLEY/WidevineProxy2/releases)
    2. Navigate to `about:debugging#/runtime/this-firefox`
    3. Click `Load Temporary Add-on...` and select the downloaded file

## Setup
### Widevine Device
If you only have a `device_client_id_blob` and `device_private_key`, run this command to create a .wvd file:
```
pywidevine create-device -k device_private_key -c device_client_id_blob -t "ANDROID" -l 3
```
Now, open the extension, click `Choose File` and select your Widevine Device file.

### Remote CDM
If you don't already have a `remote.json` file, open the API URL in the browser (if provided) and save the response as `remote.json`. \
Now, open the extension, click `Choose remote.json` and select the JSON file provided by your API.


+ Select the type of device you're using in the top right-hand corner
+ The files are saved in the extension's `chrome.storage.sync` storage and will be synchronized across any browsers into which the user is signed in with their Google account.
+ The maximum number of Widevine devices is ~25 **OR** ~200 Remote CDMs
+ Check `Enabled` to activate the message interception and you're done.

## Usage
All the user has to do is to play a DRM protected video and the decryption keys should appear in the `Keys` group box (if the service is not unsupported, as stated above). \
Keys are saved:
+ Temporarily until the extension is either refreshed manually (if installed temporarily) or a removal of the keys is manually initiated.
+ Permanently in the extension's `chrome.storage.local` storage until manually wiped or exported via the command line.
> [!NOTE]  
> The video will not play when the interception is active, as the Widevine CDM library isn't able to decrypt the Android CDM license.

+ Click the `+` button to expand the section to reveal the PSSH and keys.

## FAQ
> What if I'm unable to get the keys?

This automatically means that the license server is blocking your CDM and that you either need a CDM from a physical device, a ChromeCDM, or an L1 Android CDM. Don't ask where you can get these

## Issues
+ DRM playback won't work when the extension is disabled and EME Logger is active. This is caused by my fix for dealing with EME Logger interference (solutions are welcome).

## Demo
[Widevineproxy2.webm](https://github.com/user-attachments/assets/8f51cee3-50e2-4aa4-b244-afa2d0b2987e)

## Disclaimer
+ This program is intended solely for educational purposes.
+ Do not use this program to decrypt or access any content for which you do not have the legal rights or explicit permission.
+ Unauthorized decryption or distribution of copyrighted materials is a violation of applicable laws and intellectual property rights.
+ This tool must not be used for any illegal activities, including but not limited to piracy, circumventing digital rights management (DRM), or unauthorized access to protected content.
+ The developers, contributors, and maintainers of this program are not responsible for any misuse or illegal activities performed using this software.
+ By using this program, you agree to comply with all applicable laws and regulations governing digital rights and copyright protections.

## Credits
+ [node-widevine](https://github.com/Frooastside/node-widevine)
+ [forge](https://github.com/digitalbazaar/forge)
+ [protobuf.js](https://github.com/protobufjs/protobuf.js)
