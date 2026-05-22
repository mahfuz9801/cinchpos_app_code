const WRITE_DELAY_MS = 180;
const pendingWrites = new Map();
const pendingTimers = new Map();

function clearPendingTimer(key) {
  const timer = pendingTimers.get(key);
  if (timer) {
    window.clearTimeout(timer);
    pendingTimers.delete(key);
  }
}

function commitStoredValue(key) {
  if (typeof window === "undefined") {
    return;
  }

  const entry = pendingWrites.get(key);
  if (!entry) {
    clearPendingTimer(key);
    return;
  }

  try {
    const serializedValue = entry.kind === "json"
      ? JSON.stringify(entry.value)
      : String(entry.value ?? "");
    window.localStorage.setItem(key, serializedValue);
  } catch (error) {
    console.warn(`Could not persist local data for ${key}.`, error);
  } finally {
    pendingWrites.delete(key);
    clearPendingTimer(key);
  }
}

function scheduleStoredValue(key, entry, immediate = false) {
  if (typeof window === "undefined") {
    return;
  }

  pendingWrites.set(key, entry);
  clearPendingTimer(key);

  if (immediate) {
    commitStoredValue(key);
    return;
  }

  const timer = window.setTimeout(() => commitStoredValue(key), WRITE_DELAY_MS);
  pendingTimers.set(key, timer);
}

export function readStoredJSON(key, fallback) {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredJSON(key, value, options = {}) {
  scheduleStoredValue(key, { kind: "json", value }, options.immediate);
}

export function readStoredValue(key, fallback = "") {
  if (typeof window === "undefined") {
    return fallback;
  }

  const value = window.localStorage.getItem(key);
  return value ?? fallback;
}

export function writeStoredValue(key, value, options = {}) {
  scheduleStoredValue(key, { kind: "string", value }, options.immediate);
}

export function flushStoredWrites() {
  if (typeof window === "undefined") {
    return;
  }

  [...pendingWrites.keys()].forEach((key) => {
    commitStoredValue(key);
  });
}

export function clearStoredValue(key) {
  if (typeof window !== "undefined") {
    clearPendingTimer(key);
    pendingWrites.delete(key);
    window.localStorage.removeItem(key);
  }
}
