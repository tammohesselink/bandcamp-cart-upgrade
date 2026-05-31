const SETTINGS_KEY = 'bcp_settings_v1';

interface BcpSettings {
  showCartHistoryBtn: boolean;
}

async function loadSettings(): Promise<BcpSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<BcpSettings> | undefined;
  return { showCartHistoryBtn: true, ...stored };
}

async function saveSetting<K extends keyof BcpSettings>(key: K, value: BcpSettings[K]): Promise<void> {
  const current = await loadSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, [key]: value } });
}

async function loadShowDiscographyButton(): Promise<boolean> {
  const result = await chrome.storage.local.get('showDiscographyButton');
  const v = result['showDiscographyButton'];
  return typeof v === 'boolean' ? v : true;
}

function addToggle(container: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void): void {
  const row = document.createElement('div');
  row.className = 'setting';

  const labelEl = document.createElement('span');
  labelEl.className = 'setting-label';
  labelEl.textContent = label;

  const toggleWrapper = document.createElement('label');
  toggleWrapper.className = 'toggle';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));

  const track = document.createElement('span');
  track.className = 'toggle-track';

  toggleWrapper.append(input, track);
  row.append(labelEl, toggleWrapper);
  container.appendChild(row);
}

async function init(): Promise<void> {
  const [settings, showDisco] = await Promise.all([
    loadSettings(),
    loadShowDiscographyButton(),
  ]);

  const container = document.getElementById('settings')!;

  addToggle(container, 'Show cart history button', settings.showCartHistoryBtn, (v) => {
    saveSetting('showCartHistoryBtn', v);
  });

  addToggle(container, 'Show play button on top of label pages', showDisco, (v) => {
    chrome.storage.local.set({ showDiscographyButton: v });
  });
}

init().catch(console.error);
