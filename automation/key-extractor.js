// Node-side Widevine (WVD) key extractor for the DASH channel monitor.
//
// This is the headless, extension-free port of the WidevineProxy2 browser
// extension's local-device crypto path (background.js -> WidevineDevice +
// Session). It re-signs the EME license challenge with YOUR local .wvd device
// and decrypts the returned license to recover the content keys, exactly like
// the extension does -- but it runs inside the Playwright worker instead of a
// Chrome extension service worker.
//
// Loading strategy:
//   * protobuf.min.js / license_protocol.min.js are loaded by the side-effect
//     `import` statements inside lib/device.js + lib/cdm.js. Those bundles are
//     UMD/browserify packages that attach to the global object, so importing
//     them as ES modules is enough.
//   * forge.min.js is loaded via vm.runInThisContext() because its first line is
//     `const window = self;` which would throw under a normal ESM import. We set
//     globalThis.self = globalThis first so the bundle evaluates cleanly and
//     attaches globalThis.forge.
//
// The crypto itself (lib/cdm.js, lib/device.js, lib/cmac.js, lib/util.js) is
// pure JavaScript and Node-portable; the only browser-only bits in the original
// repo are the chrome.runtime message relay and chrome.storage, which we
// replace with page.exposeFunction() in the monitor.

import { readFileSync } from "node:fs";
import nodeCrypto from "node:crypto";
import vm from "node:vm";

// 1) Give the forge UMD bundle the globals it expects.
if (typeof globalThis.self === "undefined") {
  globalThis.self = globalThis;
}
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}

// 2) Load forge via vm (NOT as an ESM import -- see note above).
const BUNDLE_BASE = new URL("../lib/", import.meta.url);
function loadBundle(file) {
  const code = readFileSync(new URL(file, BUNDLE_BASE), "utf8");
  // runInThisContext shares the real global object, so globalThis.forge persists.
  vm.runInThisContext(code, { filename: `lib/${file}` });
}
loadBundle("forge.min.js");

// 3) Bind forge's RNG to Node's CSPRNG. Inside vm.runInThisContext the forge
//    bundle cannot see `require("crypto")` or a browser `crypto.getRandomValues`
//    the way it expects, so its native randomBytes stays undefined and RSA
//    signing/key generation fails with "n.randomBytes is not a function".
//    We force the deterministic Node source instead. forge.random returns
//    binary (latin1) strings, which is what the rest of the crypto expects.
if (globalThis.forge?.random) {
  const toBinary = (buf) => buf.toString("binary");
  globalThis.forge.random.getBytesSync = (n) => toBinary(nodeCrypto.randomBytes(n));
  globalThis.forge.random.getBytes = (n, callback) => {
    const bytes = toBinary(nodeCrypto.randomBytes(n));
    if (callback) {
      callback(null, bytes);
      return undefined;
    }
    return bytes;
  };
}

// 3) Import the pure-JS crypto. Their side-effect imports populate the protobuf
//    + license_protocol globals on globalThis.
const { WidevineDevice } = await import("../lib/device.js");
const { Session } = await import("../lib/cdm.js");

const LICENSE_PROTOCOL = globalThis.protobuf.roots.default.license_protocol;
const { LicenseType, SignedMessage, LicenseRequest, License } = LICENSE_PROTOCOL;

// --- small base64 helpers (Node Buffer based) -------------------------------
function b64Decode(value) {
  return Uint8Array.from(Buffer.from(value, "base64"));
}
function b64Encode(bytes) {
  return Buffer.from(bytes).toString("base64");
}

// Accept the EME payload in whatever form the caller hands it. The browser now
// ships raw bytes as a JSON number array (via page.exposeFunction), but we still
// tolerate a base64 string for resilience/testing.
function toBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (Array.isArray(input)) {
    return Uint8Array.from(input);
  }
  if (typeof input === "string") {
    return b64Decode(input);
  }
  throw new Error("unsupported challenge/license input");
}

// The `Session` round trip produces a challenge and later needs the same
// `Session` instance to decrypt the matching license. We key it by the
// base64 request id, mirroring background.js.
function createKeyExtractor({ deviceB64 }) {
  if (!deviceB64 || typeof deviceB64 !== "string") {
    throw new Error("WIDEVINE_DEVICE_B64 is required to extract keys");
  }

  // Parse the .wvd (same steps as background.js generateChallenge).
  const device = new WidevineDevice(b64Decode(deviceB64).buffer);
  const privateKey = `-----BEGIN RSA PRIVATE KEY-----${b64Encode(device.private_key)}-----END RSA PRIVATE KEY-----`;
  const deviceInfo = {
    identifierBlob: device.client_id_bytes,
    name: device.get_name(),
    type: device.type,
  };

  const sessionsByRequestId = new Map();

  function createChallenge(input) {
    const signedMessage = SignedMessage.decode(toBytes(input));
    const licenseRequest = LicenseRequest.decode(signedMessage.msg);
    const psshData = licenseRequest.contentId.widevinePsshData.psshData[0];
    if (!psshData) {
      throw new Error("NO_PSSH_DATA_IN_CHALLENGE");
    }

    const session = new Session(
      {
        privateKey,
        identifierBlob: deviceInfo.identifierBlob,
      },
      psshData,
    );

    const [challenge, requestId] = session.createLicenseRequest(
      LicenseType.STREAMING,
      deviceInfo.type === 2,
    );
    sessionsByRequestId.set(b64Encode(requestId), session);
    // Return raw bytes (as number arrays) for BOTH the re-signed challenge and
    // the PSSH so the browser can rebuild them without any base64 round-trip
    // across the exposeFunction boundary. Base64 strings were getting truncated
    // in transit, which surfaced as protobuf "index out of range" errors.
    return { challenge: Array.from(challenge), pssh: Array.from(psshData) };
  }

  function parseLicense(input) {
    const license = toBytes(input);
    const signedLicenseMessage = SignedMessage.decode(license);
    if (signedLicenseMessage.type !== SignedMessage.MessageType.LICENSE) {
      // ClearKey or a non-license message; nothing for us to decrypt.
      return [];
    }

    const licenseObj = License.decode(signedLicenseMessage.msg);
    const loadedRequestId = b64Encode(licenseObj.id.requestId);
    const session = sessionsByRequestId.get(loadedRequestId);
    if (!session) {
      return [];
    }

    const keys = session.parseLicense(license);
    sessionsByRequestId.delete(loadedRequestId);

    // Normalize to hex { kid, k } so the backend can consume key id vs value.
    return keys.map(({ kid, k }) => ({
      kid: kid.toLowerCase(),
      k: k.toLowerCase(),
    }));
  }

  return {
    deviceName: deviceInfo.name,
    createChallenge,
    parseLicense,
  };
}

export { createKeyExtractor, b64Decode, b64Encode };
