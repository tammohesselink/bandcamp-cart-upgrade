export const SETTINGS_KEY = 'bcp_settings_v1';

export interface BcpSettings {
  showCartHistoryBtn: boolean;
  darkMode: boolean;
  // Reveals the advanced options in the popup. Hiding them does not change their values.
  showAdvanced: boolean;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: BcpSettings = {
  showCartHistoryBtn: true,
  darkMode: false,
  showAdvanced: false,
  debugLogging: false,
};

export function withDefaults(stored: Partial<BcpSettings> | undefined): BcpSettings {
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function loadSettings(): Promise<BcpSettings> {
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    return withDefaults(result[SETTINGS_KEY] as Partial<BcpSettings> | undefined);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Calls back with the new settings whenever the popup changes them, so open tabs follow without a reload.
export function onSettingsChanged(callback: (settings: BcpSettings) => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(SETTINGS_KEY in changes)) return;
    callback(withDefaults(changes[SETTINGS_KEY]!.newValue as Partial<BcpSettings> | undefined));
  });
}

export async function saveSetting<K extends keyof BcpSettings>(key: K, value: BcpSettings[K]): Promise<void> {
  const current = await loadSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, [key]: value } });
}
