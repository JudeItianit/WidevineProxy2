// In-page EME proxy hook for key extraction. This is the headless port of the
// WidevineProxy2 content_script.js "REQUEST" / "RESPONSE" relay, with one
// crucial change: instead of bouncing the challenge/license through the Chrome
// extension's chrome.runtime.sendMessage, it calls Node-side functions that we
// exposed with page.exposeFunction() in monitor.js:
//
//     window.__wvdCreateChallenge(challengeBytes:number[]) -> { challenge:number[], pssh:number[] }
//     window.__wvdParseLicense(licenseBytes:number[])      -> [{ kid, k, keyString }]
//
// NOTE: we ship RAW BYTES as JSON number arrays across the exposeFunction boundary,
// not base64 strings. Base64 strings were being truncated/corrupted in transit
// (surfaced as protobuf "index out of range: 3 + 107 > 54"), which number arrays
// cannot suffer.
//
// Those two functions run the local .wvd crypto in the Playwright worker and
// return the re-signed challenge / extracted keys.
//
// This hook must be installed with context.addInitScript() so it is present in
// every frame before the page's own scripts run.

export function installKeyExtractionHook() {
  // NOTE: do NOT bail out here when __wvdCreateChallenge / __wvdParseLicense are
  // not yet defined. Those two functions are bound by Playwright's
  // page.exposeFunction(), which is installed as a *separate* init script that
  // runs AFTER this one. So at this point in time they are always undefined.
  // We therefore install the EME proxies unconditionally and instead check for
  // the functions at event time (when the EME exchange actually fires), by
  // which point the exposeFunction bindings are guaranteed present. Bailing out
  // here was the original reason keys came back empty.

  const b64 = {
    decode: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
    encode: (b) => btoa(String.fromCharCode(...new Uint8Array(b))),
  };

  // Compact hex preview so the next diagnostic run tells us WHAT a truncated
  // buffer actually is (message type tag, SignedMessage type, etc.) rather than
  // just how many bytes arrived.
  const bytesToHex = (b) =>
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, "0"))
      .join(" ");

  const base64UrlToBytes = (s) => {
    const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  };

  // Accumulate everything we extract for this navigation. The counters below are
  // the only signal we get about WHETHER the MITM actually engaged (vs. the EME
  // happening in a frame where the exposeFunction binding never arrived), so they
  // are surfaced in the report via collectExtractedKeys().
  Object.defineProperty(globalThis, "__channelHealthKeys", {
    configurable: true,
    enumerable: false,
    value: {
      errors: [],
      keys: [],
      pssh: [],
      hookActive: true,
      challengeCalls: 0,
      licenseCalls: 0,
      createSkippedNoFn: 0,
      // ClearKey fallback counters. Headless Chromium (Playwright's bundled
      // Chromium) ships WITHOUT the proprietary Widevine CDM, so the site falls
      // back to the W3C ClearKey system. ClearKey needs no device key and
      // delivers the content key in cleartext inside the license JSON, so the
      // WVD re-sign path does not apply -- but we still capture the keys.
      clearKeyChallengeCalls: 0,
      clearKeyLicenseCalls: 0,
      // Per-hop byte counts + a hex preview of the first bytes so we can confirm
      // the raw-bytes transport is intact (and instantly localize any future
      // truncation to browser vs. transport) AND see WHAT a short buffer actually
      // is (message type tag, SignedMessage type, etc.).
      diag: {
        inChallengeBytes: null,
        challengeMessageType: null,
        challengeFirstHex: null,
        challengeIsClearKey: null,
        outChallengeBytes: null,
        inLicenseBytes: null,
        licenseFirstHex: null,
        licenseIsClearKey: null,
        outKeyCount: null,
      },
    },
    writable: true,
  });

  const proxy = (object, method, handler) => {
    const original = object[method];
    if (typeof original !== "function") {
      return;
    }
    Object.defineProperty(object, method, {
      configurable: true,
      value: new Proxy(original, { apply: handler }),
      writable: true,
    });
  };

  // Intercept the EME license-request challenge and re-sign it with the WVD
  // device so the license server returns keys we can decrypt.
  if (typeof EventTarget !== "undefined") {
    proxy(EventTarget.prototype, "addEventListener", (target, thisArg, args) => {
      const [type, listener] = args;
      if (
        !thisArg
        || typeof MediaKeySession === "undefined"
        || !(thisArg instanceof MediaKeySession)
        || typeof MediaKeyMessageEvent === "undefined"
        || type !== "message"
        || !listener
      ) {
        return target.apply(thisArg, args);
      }

      args[1] = async function (event) {
        // Guard at EVENT time: the Node exposed functions only become available
        // after page.exposeFunction() runs its own init script. If key extraction
        // is disabled, __wvdCreateChallenge is never exposed and we leave the event
        // untouched so normal playback proceeds.
        const looksLikeChallenge = (
          event instanceof MediaKeyMessageEvent
          && event.isTrusted
          && event.message.byteLength > 2
        );
        if (looksLikeChallenge && typeof globalThis.__wvdCreateChallenge === "function") {
          const oldBytes = new Uint8Array(event.message);
          globalThis.__channelHealthKeys.diag.inChallengeBytes = oldBytes.length;
          globalThis.__channelHealthKeys.diag.challengeMessageType = event.messageType ?? null;
          globalThis.__channelHealthKeys.diag.challengeFirstHex = bytesToHex(oldBytes.subarray(0, 16));

          // ClearKey / JSON license request: headless Chromium has no Widevine CDM,
          // so the site fell back to the W3C ClearKey system. The challenge is plain
          // JSON ({"kids":[...]}), not a Widevine SignedMessage protobuf, so the WVD
          // re-sign does not apply. Pass it through untouched; the cleartext keys
          // arrive in the license response, which we capture in the update() proxy.
          const isClearKey = oldBytes[0] === 0x7b; // '{'
          if (isClearKey) {
            globalThis.__channelHealthKeys.clearKeyChallengeCalls += 1;
            globalThis.__channelHealthKeys.diag.challengeIsClearKey = true;
            if (listener.handleEvent) {
              listener.handleEvent.call(listener, event);
            } else {
              listener.call(this, event);
            }
            return;
          }

          try {
            globalThis.__channelHealthKeys.challengeCalls += 1;
            // Ship raw bytes (as a number array) across the exposeFunction boundary.
            // JSON number arrays can't be charset-truncated the way base64 strings were.
            const result = await globalThis.__wvdCreateChallenge(Array.from(oldBytes));
            const newChallengeBytes = Array.isArray(result?.challenge)
              ? Uint8Array.from(result.challenge)
              : null;
            if (newChallengeBytes) {
              globalThis.__channelHealthKeys.diag.outChallengeBytes = newChallengeBytes.length;
            }
            if (Array.isArray(result?.pssh) && result.pssh.length) {
              globalThis.__channelHealthKeys.pssh.push(
                b64.encode(Uint8Array.from(result.pssh)),
              );
            }
            if (!newChallengeBytes) {
              throw new Error("key extractor returned no challenge bytes");
            }
            const clonedEvent = new MediaKeyMessageEvent("message", {
              messageType: event.messageType,
              message: newChallengeBytes.buffer,
            });
            event.stopImmediatePropagation();
            event.preventDefault();
            thisArg.dispatchEvent(clonedEvent);
            return;
          } catch (err) {
            globalThis.__channelHealthKeys.errors.push(String(err?.message || err));
            // Fall back to the original challenge so playback can still proceed
            // without extracted keys.
          }
        } else if (looksLikeChallenge) {
          // The EME challenge reached our wrapper but the exposeFunction binding
          // was NOT present in this frame. That almost always means the player
          // runs in an iframe whose realm never received the exposeFunction
          // binding -- the signal we need to switch to in-page crypto.
          globalThis.__channelHealthKeys.createSkippedNoFn += 1;
        }

        if (listener.handleEvent) {
          listener.handleEvent.call(listener, event);
        } else {
          listener.call(this, event);
        }
      };

      return target.apply(thisArg, args);
    });
  }

  // Intercept the license update so we can decrypt the returned license and
  // capture the content keys.
  if (typeof MediaKeySession !== "undefined") {
    proxy(MediaKeySession.prototype, "update", async (target, thisArg, args) => {
      if (
        thisArg == null
        || !(thisArg instanceof MediaKeySession)
        || typeof globalThis.__wvdParseLicense !== "function"
      ) {
        return target.apply(thisArg, args);
      }

      try {
        const licenseBytes = new Uint8Array(args[0]);
        globalThis.__channelHealthKeys.diag.inLicenseBytes = licenseBytes.length;
        globalThis.__channelHealthKeys.diag.licenseFirstHex = bytesToHex(licenseBytes.subarray(0, 16));

        // ClearKey license: plain JSON {"keys":[{"kty":"oct","k":"<b64u>","kid":"<b64u>"}]}.
        // The content key is delivered in cleartext, so we extract it directly and
        // pass the license through to the CDM unchanged (no WVD re-sign needed).
        const isClearKey = licenseBytes[0] === 0x7b; // '{'
        if (isClearKey) {
          globalThis.__channelHealthKeys.clearKeyLicenseCalls += 1;
          globalThis.__channelHealthKeys.diag.licenseIsClearKey = true;
          try {
            const json = JSON.parse(new TextDecoder().decode(licenseBytes));
            const keys = (Array.isArray(json.keys) ? json.keys : [])
              .filter((k) => k && k.kty === "oct" && k.k)
              .map((k) => {
                const keyBytes = base64UrlToBytes(k.k);
                const kidBytes = k.kid ? base64UrlToBytes(k.kid) : null;
                const kidHex = kidBytes ? bytesToHex(kidBytes).replace(/ /g, "") : null;
                const keyHex = bytesToHex(keyBytes).replace(/ /g, "");
                return {
                  kid: kidHex,
                  k: keyHex,
                  clearKey: true,
                };
              });
            globalThis.__channelHealthKeys.diag.outKeyCount = keys.length;
            if (keys.length > 0) {
              globalThis.__channelHealthKeys.keys.push(...keys);
            }
          } catch (parseErr) {
            globalThis.__channelHealthKeys.errors.push(
              `clearkey license parse failed: ${String(parseErr?.message || parseErr)}`,
            );
          }
          return target.apply(thisArg, args);
        }

        globalThis.__channelHealthKeys.licenseCalls += 1;
        const keys = await globalThis.__wvdParseLicense(Array.from(licenseBytes));
        globalThis.__channelHealthKeys.diag.outKeyCount = Array.isArray(keys)
          ? keys.length
          : 0;
        if (Array.isArray(keys) && keys.length > 0) {
          globalThis.__channelHealthKeys.keys.push(...keys);
        }
      } catch (err) {
        globalThis.__channelHealthKeys.errors.push(String(err?.message || err));
      }

      try {
        return await target.apply(thisArg, args);
      } catch {
        // The WVD-encrypted license cannot be consumed by the browser's own CDM;
        // that is expected for key extraction and safe to ignore here.
      }
      return undefined;
    });
  }
}
