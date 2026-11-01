export const SETTINGS_KEY = 'bcp_settings_v1';

export interface BcpSettings {
  showCartHistoryBtn: boolean;
  darkMode: boolean;
  namedCartsEnabled: boolean;
  // Reveals the advanced options in the popup. Hiding them does not change their values.
  showAdvanced: boolean;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: BcpSettings = {
  showCartHistoryBtn: true,
  darkMode: false,
  namedCartsEnabled: true,
  showAdvanced: false,
  debugLogging: false,
};

export function withDefaults(stored: Partial<BcpSettings> | undefined): BcpSettings {
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function readStoredSettings(): Promise<BcpSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return withDefaults(result[SETTINGS_KEY] as Partial<BcpSettings> | undefined);
}

export async function loadSettings(): Promise<BcpSettings> {
  try {
    return await readStoredSettings();
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

// Saves run one after another, so two quick toggles can't both read the old settings and
// undo each other. A failed read aborts the save instead of writing defaults over the rest.
let saving: Promise<void> = Promise.resolve();

export function saveSetting<K extends keyof BcpSettings>(key: K, value: BcpSettings[K]): Promise<void> {
  const save = saving.then(async () => {
    const current = await readStoredSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, [key]: value } });
  });
  saving = save.catch(() => {});
  return save;
}
