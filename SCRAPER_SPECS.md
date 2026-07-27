# Task: Build a Server-Side Widevine Key & MPD Extractor via GitHub Actions

I am providing you with a repository containing a JavaScript Widevine CDM implementation (`device.js`, `cdm.js`, `cmac.js`, `utils.js`, Protobuf files) and a Widevine device file (`device.wvd`). 

Your goal is to build an automated Node.js script and a scheduled GitHub Actions workflow that uses Playwright to capture dynamic stream manifests (`.mpd`), extract PSSH/License challenges, decrypt Widevine keys using our local CDM engine, and POST the output to a remote server endpoint.

---

## Technical Specifications

### 1. Requirements & Core Dependencies
- Use **Node.js (v20+)** ES modules (`"type": "module"` in `package.json`).
- Dependencies to include:
  - `@playwright/test` / `playwright` (Chromium runner)
  - `playwright-extra` and `puppeteer-extra-plugin-stealth` (for bot-detection bypass)
  - `node-fetch` or native Node `fetch` for sending POST payloads
  - Existing local repository files (`device.js`, `cdm.js`, etc.)

---

### 2. Main Script (`extractor.js`)

Create a script `extractor.js` that performs the following steps:

1. **Environment Setup & WVD Loading:**
   - Read the `.wvd` device credentials. Check if `process.env.WVD_BASE64` is set; if so, decode it from Base64. Otherwise, fallback to reading `./device.wvd` from disk.
   - Instantiate `WidevineDevice` from `device.js` using the raw binary buffer.

2. **Headless Browser Interception (Playwright):**
   - Launch Playwright Chromium in headless mode configured with the stealth plugin.
   - Target URL should be loaded from `process.env.TARGET_STREAM_URL`.
   - Set up event listeners on page requests/responses:
     - **MPD Manifest:** Intercept and capture any URL ending with or containing `.mpd`.
     - **Widevine License Exchange:** Intercept network requests matching Widevine license endpoints (POST requests carrying license challenge/response payloads). Capture both the request PSSH/Challenge and the raw binary response body (`ArrayBuffer`).

3. **Key Decryption:**
   - Take the captured PSSH / initData and license response body.
   - Create a new CDM session using `Session` from `cdm.js` initialized with `device.private_key` and `device.client_id_bytes`.
   - Call `session.parseLicense(licenseResponseBodyBuffer)` to extract the decrypted array of `{ kid, k }` pairs.
   - Format the keys as standard hex strings (`KID:KEY`).

4. **Payload Delivery:**
   - Construct a JSON payload containing:
     ```json
     {
       "timestamp": "ISO_TIMESTAMP",
       "mpd_url": "CAPTURED_MPD_URL",
       "keys": ["KID1:KEY1", "KID2:KEY2"]
     }
     ```
   - Send an HTTP `POST` request to `process.env.SERVER_ENDPOINT` with `Authorization: Bearer ${process.env.API_AUTH_TOKEN}` header containing this payload.
   - Log progress clearly to console and exit cleanly with code `0` on success or code `1` on error.

---

### 3. GitHub Actions Workflow (`.github/workflows/key-extractor.yml`)

Create a GitHub Actions workflow that:
- Triggers on a scheduled `cron: '0 */6 * * *'` (every 6 hours) and supports `workflow_dispatch` for manual runs.
- Runs on `ubuntu-latest`.
- Sets up Node 20 and installs Playwright with Chromium dependencies (`npx playwright install --with-deps chromium`).
- Passes secrets to environment variables:
  - `SERVER_ENDPOINT`: `${{ secrets.SERVER_ENDPOINT }}`
  - `API_AUTH_TOKEN`: `${{ secrets.API_AUTH_TOKEN }}`
  - `TARGET_STREAM_URL`: `${{ secrets.TARGET_STREAM_URL }}`
  - `WVD_BASE64`: `${{ secrets.WVD_BASE64 }}`
- Executes `node extractor.js`.

---

## Instructions for Execution
1. Review the existing CDM codebase in the repository (`device.js`, `cdm.js`, `cmac.js`).
2. Generate/update `package.json` with required dependencies.
3. Write `extractor.js` with proper error handling and logging.
4. Write `.github/workflows/key-extractor.yml`.
5. Ensure code is modular, clean, and uses standard ES module syntax.