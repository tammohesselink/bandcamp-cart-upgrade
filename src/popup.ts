import type { CartSnapshot } from './types';
import {
  buildHistoryExport,
  countNewSnapshots,
  loadSnapshots,
  mergeSnapshots,
  parseHistoryExport,
  saveSnapshots,
} from './cart-history';
import { log, initDebugLogging } from './log';
import { loadSettings, saveSetting } from './settings';

// Chrome closes the action popup as soon as a file picker opens, so importing happens
// in a tab that shows this same page.
const IMPORT_TAB_PARAM = 'import';

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

function setStatus(statusElement: HTMLElement, message: string, isError = false): void {
  statusElement.textContent = message;
  statusElement.classList.toggle('error', isError);
}

function addButton(container: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action-button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  container.appendChild(button);
  return button;
}

async function exportHistory(statusElement: HTMLElement): Promise<void> {
  const snapshots = await loadSnapshots();
  if (snapshots.length === 0) {
    setStatus(statusElement, 'No cart history to export yet.', true);
    return;
  }
  const json = JSON.stringify(buildHistoryExport(snapshots), null, 2);
  // A data URL carries the file contents itself, so the download survives the popup closing
  // (for example when Chrome's "Ask where to save" dialog takes focus). A blob URL would not.
  const link = document.createElement('a');
  link.href = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  link.download = `bandcamp-cart-history-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setStatus(statusElement, `Exported ${snapshots.length} cart snapshot${snapshots.length === 1 ? '' : 's'}.`);
}

async function importHistory(file: File, statusElement: HTMLElement): Promise<void> {
  let imported: CartSnapshot[];
  try {
    imported = parseHistoryExport(await file.text());
  } catch (error) {
    setStatus(statusElement, error instanceof Error ? error.message : 'Could not read file.', true);
    return;
  }
  const existing = await loadSnapshots();
  const merged = mergeSnapshots(existing, imported);
  await saveSnapshots(merged);
  const added = countNewSnapshots(existing, merged);
  setStatus(
    statusElement,
    `Imported ${added} new cart snapshot${added === 1 ? '' : 's'} (${merged.length} in history). ` +
      'Reload any open Bandcamp tabs to see them.'
  );
}

function addHistoryTransfer(container: HTMLElement): void {
  const isImportTab = new URLSearchParams(location.search).has(IMPORT_TAB_PARAM);

  const heading = document.createElement('h2');
  heading.textContent = 'Cart history';

  const description = document.createElement('p');
  description.className = 'section-description';
  description.textContent = 'Move your cart history to another browser: export it here, then import the file there.';

  const buttons = document.createElement('div');
  buttons.className = 'action-buttons';

  const statusElement = document.createElement('p');
  statusElement.className = 'status';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) importHistory(file, statusElement).catch((error) => setStatus(statusElement, String(error), true));
    fileInput.value = '';
  });

  addButton(buttons, 'Export', () => {
    exportHistory(statusElement).catch((error) => setStatus(statusElement, String(error), true));
  });
  addButton(buttons, 'Import', () => {
    if (isImportTab) {
      fileInput.click();
    } else {
      chrome.tabs
        .create({ url: chrome.runtime.getURL(`popup.html?${IMPORT_TAB_PARAM}`) })
        .then(() => window.close())
        .catch((error) => setStatus(statusElement, String(error), true));
    }
  });

  container.append(heading, description, buttons, fileInput, statusElement);
  if (isImportTab) setStatus(statusElement, 'Click Import and choose an exported cart history file.');
}

async function init(): Promise<void> {
  await initDebugLogging();
  const [settings, showDisco] = await Promise.all([
    loadSettings(),
    loadShowDiscographyButton(),
  ]);

  const container = document.getElementById('settings')!;
  const advanced = document.getElementById('advanced')!;
  advanced.hidden = !settings.showAdvanced;

  addToggle(container, 'Show play button on top of label pages', showDisco, (v) => {
    chrome.storage.local.set({ showDiscographyButton: v });
  });

  addToggle(container, 'Dark mode for the player', settings.darkMode, (v) => {
    saveSetting('darkMode', v);
  });

  addToggle(container, 'Show advanced functionality', settings.showAdvanced, (v) => {
    advanced.hidden = !v;
    saveSetting('showAdvanced', v);
  });

  const advancedSettings = document.getElementById('advanced-settings')!;

  addToggle(advancedSettings, 'Show cart history button', settings.showCartHistoryBtn, (v) => {
    saveSetting('showCartHistoryBtn', v);
  });

  addToggle(advancedSettings, 'Debug logging in the browser console', settings.debugLogging, (v) => {
    saveSetting('debugLogging', v);
  });

  addHistoryTransfer(document.getElementById('history-transfer')!);
}

init().catch(log.error);
