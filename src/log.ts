import { loadSettings, onSettingsChanged } from './settings';

// All extension logging goes through here so the "Debug logging" option in the popup's
// advanced section can switch it on and off. Off by default, warnings and errors included.
let debugLogging = false;

export function setDebugLogging(enabled: boolean): void {
  debugLogging = enabled;
}

// Reads the stored option and follows later changes, so flipping it in the popup
// takes effect in open tabs without a reload.
export async function initDebugLogging(): Promise<void> {
  let changed = false;
  onSettingsChanged((settings) => {
    changed = true;
    setDebugLogging(settings.debugLogging);
  });
  const settings = await loadSettings();
  // A change that arrived while reading is newer than what the read returned.
  if (!changed) setDebugLogging(settings.debugLogging);
}

export const log = {
  info: (...args: unknown[]): void => {
    if (debugLogging) console.log(...args);
  },
  table: (data: unknown): void => {
    if (debugLogging) console.table(data);
  },
  warn: (...args: unknown[]): void => {
    if (debugLogging) console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    if (debugLogging) console.error(...args);
  },
  // Always printed: a crash at startup can break the popup, and with it the option itself.
  fatal: (...args: unknown[]): void => {
    console.error(...args);
  },
};
