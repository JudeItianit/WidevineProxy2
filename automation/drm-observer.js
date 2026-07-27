export function installDrmObserver() {
  const state = {
    generateRequestCalls: 0,
    keySystemAccessGranted: 0,
    keySystemAccessRequests: 0,
    keySystems: [],
    licenseUpdateAttempts: 0,
    licenseUpdatesApplied: 0,
    mediaKeysAttached: 0,
    sessionsCreated: 0,
  };

  Object.defineProperty(globalThis, "__channelHealthDrmLifecycle", {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  });

  const rememberKeySystem = (keySystem) => {
    const value = String(keySystem);
    if (!state.keySystems.includes(value)) {
      state.keySystems.push(value);
    }
  };

  try {
    const originalRequestAccess = Navigator.prototype.requestMediaKeySystemAccess;
    if (typeof originalRequestAccess === "function") {
      Navigator.prototype.requestMediaKeySystemAccess = async function requestMediaKeySystemAccess(
        keySystem,
        configurations,
      ) {
        state.keySystemAccessRequests += 1;
        rememberKeySystem(keySystem);
        const access = await originalRequestAccess.call(this, keySystem, configurations);
        state.keySystemAccessGranted += 1;
        return access;
      };
    }
  } catch {
    // EME is unavailable or its prototype cannot be instrumented in this frame.
  }

  try {
    const originalCreateSession = MediaKeys.prototype.createSession;
    MediaKeys.prototype.createSession = function createSession(...args) {
      const session = originalCreateSession.apply(this, args);
      state.sessionsCreated += 1;
      return session;
    };
  } catch {
    // MediaKeys is unavailable in this frame.
  }

  try {
    const originalSetMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
    HTMLMediaElement.prototype.setMediaKeys = async function setMediaKeys(mediaKeys) {
      const result = await originalSetMediaKeys.call(this, mediaKeys);
      if (mediaKeys) {
        state.mediaKeysAttached += 1;
      }
      return result;
    };
  } catch {
    // setMediaKeys is unavailable in this frame.
  }

  try {
    const originalGenerateRequest = MediaKeySession.prototype.generateRequest;
    MediaKeySession.prototype.generateRequest = function generateRequest(...args) {
      state.generateRequestCalls += 1;
      return originalGenerateRequest.apply(this, args);
    };
  } catch {
    // MediaKeySession is unavailable in this frame.
  }

  try {
    const originalUpdate = MediaKeySession.prototype.update;
    MediaKeySession.prototype.update = async function update(...args) {
      state.licenseUpdateAttempts += 1;
      const result = await originalUpdate.apply(this, args);
      state.licenseUpdatesApplied += 1;
      return result;
    };
  } catch {
    // MediaKeySession is unavailable in this frame.
  }
}

const EMPTY_DRM_LIFECYCLE = Object.freeze({
  generateRequestCalls: 0,
  keySystemAccessGranted: 0,
  keySystemAccessRequests: 0,
  keySystems: [],
  licenseUpdateAttempts: 0,
  licenseUpdatesApplied: 0,
  mediaKeysAttached: 0,
  sessionsCreated: 0,
});

export async function collectDrmLifecycle(page) {
  const aggregate = {
    ...EMPTY_DRM_LIFECYCLE,
    keySystems: [],
  };
  const keySystems = new Set();

  for (const frame of page.frames()) {
    const state = await frame.evaluate(() => {
      const current = globalThis.__channelHealthDrmLifecycle;
      return current ? {
        generateRequestCalls: current.generateRequestCalls,
        keySystemAccessGranted: current.keySystemAccessGranted,
        keySystemAccessRequests: current.keySystemAccessRequests,
        keySystems: [...current.keySystems],
        licenseUpdateAttempts: current.licenseUpdateAttempts,
        licenseUpdatesApplied: current.licenseUpdatesApplied,
        mediaKeysAttached: current.mediaKeysAttached,
        sessionsCreated: current.sessionsCreated,
      } : null;
    }).catch(() => null);
    if (!state) {
      continue;
    }

    for (const name of state.keySystems) {
      keySystems.add(name);
    }
    for (const field of [
      "generateRequestCalls",
      "keySystemAccessGranted",
      "keySystemAccessRequests",
      "licenseUpdateAttempts",
      "licenseUpdatesApplied",
      "mediaKeysAttached",
      "sessionsCreated",
    ]) {
      aggregate[field] += state[field] || 0;
    }
  }

  aggregate.keySystems = [...keySystems];
  return aggregate;
}
