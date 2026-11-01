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
  onSettingsChanged((settings) => setDebugLogging(settings.debugLogging));
  setDebugLogging((await loadSettings()).debugLogging);
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
};
