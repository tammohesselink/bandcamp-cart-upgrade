export const SETTINGS_KEY = 'bcp_settings_v1';

export interface BcpSettings {
  showCartHistoryBtn: boolean;
  // Reveals the advanced options in the popup. Hiding them does not change their values.
  showAdvanced: boolean;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: BcpSettings = {
  showCartHistoryBtn: true,
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

export async function saveSetting<K extends keyof BcpSettings>(key: K, value: BcpSettings[K]): Promise<void> {
  const current = await loadSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, [key]: value } });
}
