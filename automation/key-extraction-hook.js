// In-page EME proxy hook for key extraction. This is the headless port of the
// WidevineProxy2 content_script.js "REQUEST" / "RESPONSE" relay, with one
// crucial change: instead of bouncing the challenge/license through the Chrome
// extension's chrome.runtime.sendMessage, it calls Node-side functions that we
// exposed with page.exposeFunction() in monitor.js:
//
//     window.__wvdCreateChallenge(challengeB64) -> challengeB64
//     window.__wvdParseLicense(licenseB64)       -> [{ kid, k }]
//
// Those two functions run the local .wvd crypto in the Playwright worker and
// return the re-signed challenge / extracted keys.
//
// This hook must be installed with context.addInitScript() so it is present in
// every frame before the page's own scripts run.

export function installKeyExtractionHook() {
  // Only active when the monitor exposed the Node functions.
  if (
    typeof globalThis.__wvdCreateChallenge !== "function"
    || typeof globalThis.__wvdParseLicense !== "function"
  ) {
    return;
  }

  const b64 = {
    decode: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
    encode: (b) => btoa(String.fromCharCode(...new Uint8Array(b))),
  };

  // Accumulate everything we extract for this navigation.
  Object.defineProperty(globalThis, "__channelHealthKeys", {
    configurable: true,
    enumerable: false,
    value: { errors: [], keys: [] },
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
        if (
          event instanceof MediaKeyMessageEvent
          && event.isTrusted
          && event.message.byteLength > 2
        ) {
          const oldChallenge = b64.encode(event.message);
          try {
            const newChallenge = await globalThis.__wvdCreateChallenge(oldChallenge);
            const clonedEvent = new MediaKeyMessageEvent("message", {
              messageType: event.messageType,
              message: b64.decode(newChallenge).buffer,
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
      if (thisArg == null || !(thisArg instanceof MediaKeySession)) {
        return target.apply(thisArg, args);
      }

      try {
        const keys = await globalThis.__wvdParseLicense(b64.encode(args[0]));
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
