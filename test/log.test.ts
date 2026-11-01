import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log, initDebugLogging, setDebugLogging } from '../src/log';
import { SETTINGS_KEY } from '../src/settings';

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

let stored: Record<string, unknown>;
let changeListeners: ChangeListener[];

beforeEach(() => {
  stored = {};
  changeListeners = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: { get: async (key: string) => ({ [key]: stored[key] }) },
      onChanged: { addListener: (listener: ChangeListener) => changeListeners.push(listener) },
    },
  };
  setDebugLogging(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function spyOnConsole() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    table: vi.spyOn(console, 'table').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

function logEverything(): void {
  log.info('[bcp] info');
  log.table([{ a: 1 }]);
  log.warn('[bcp] warn');
  log.error('[bcp] error');
}

describe('debug logging', () => {
  it('logs nothing, warnings and errors included, when the option has never been set', async () => {
    const consoleSpies = spyOnConsole();
    await initDebugLogging();

    logEverything();

    for (const spy of Object.values(consoleSpies)) expect(spy).not.toHaveBeenCalled();
  });

  it('logs everything when the option is on', async () => {
    stored[SETTINGS_KEY] = { debugLogging: true };
    const consoleSpies = spyOnConsole();
    await initDebugLogging();

    logEverything();

    expect(consoleSpies.log).toHaveBeenCalledWith('[bcp] info');
    expect(consoleSpies.table).toHaveBeenCalledWith([{ a: 1 }]);
    expect(consoleSpies.warn).toHaveBeenCalledWith('[bcp] warn');
    expect(consoleSpies.error).toHaveBeenCalledWith('[bcp] error');
  });

  it('follows the option when it is flipped in the popup', async () => {
    const consoleSpies = spyOnConsole();
    await initDebugLogging();

    for (const listener of changeListeners) listener({ [SETTINGS_KEY]: { newValue: { debugLogging: true } } }, 'local');
    log.info('[bcp] after switching on');
    for (const listener of changeListeners) listener({ [SETTINGS_KEY]: { newValue: { debugLogging: false } } }, 'local');
    log.info('[bcp] after switching off');

    expect(consoleSpies.log).toHaveBeenCalledTimes(1);
    expect(consoleSpies.log).toHaveBeenCalledWith('[bcp] after switching on');
  });

  it('keeps a change made while the stored option was still being read', async () => {
    const consoleSpies = spyOnConsole();
    const initialising = initDebugLogging();

    for (const listener of changeListeners) listener({ [SETTINGS_KEY]: { newValue: { debugLogging: true } } }, 'local');
    await initialising;
    log.info('[bcp] on');

    expect(consoleSpies.log).toHaveBeenCalledWith('[bcp] on');
  });

  it('always prints fatal errors', async () => {
    const consoleSpies = spyOnConsole();
    await initDebugLogging();

    log.fatal('[bcp] crashed');

    expect(consoleSpies.error).toHaveBeenCalledWith('[bcp] crashed');
  });

  it('ignores changes to other storage keys', async () => {
    stored[SETTINGS_KEY] = { debugLogging: true };
    const consoleSpies = spyOnConsole();
    await initDebugLogging();

    for (const listener of changeListeners) listener({ showDiscographyButton: { newValue: false } }, 'local');
    log.info('[bcp] still on');

    expect(consoleSpies.log).toHaveBeenCalledWith('[bcp] still on');
  });
});
