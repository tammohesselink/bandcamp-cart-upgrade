import { describe, it, expect, beforeEach } from 'vitest';
import { SETTINGS_KEY, saveSetting, withDefaults } from '../src/settings';

let stored: Record<string, unknown>;
let failReads: boolean;

beforeEach(() => {
  stored = {};
  failReads = false;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        // Yields before answering, like the real asynchronous storage does.
        get: async (key: string) => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (failReads) throw new Error('storage unavailable');
          return { [key]: stored[key] };
        },
        set: async (items: Record<string, unknown>) => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          Object.assign(stored, items);
        },
      },
    },
  };
});

describe('withDefaults', () => {
  it('turns named carts on unless they were switched off', () => {
    expect(withDefaults(undefined).namedCartsEnabled).toBe(true);
    expect(withDefaults({ namedCartsEnabled: false }).namedCartsEnabled).toBe(false);
  });
});

describe('saveSetting', () => {
  it('keeps both changes when two settings are saved straight after each other', async () => {
    await Promise.all([saveSetting('showAdvanced', true), saveSetting('debugLogging', true)]);

    expect(stored[SETTINGS_KEY]).toMatchObject({ showAdvanced: true, debugLogging: true });
  });

  it('leaves the other settings alone when reading them fails', async () => {
    stored[SETTINGS_KEY] = { showCartHistoryBtn: false, darkMode: true };
    failReads = true;

    await expect(saveSetting('debugLogging', true)).rejects.toThrow('storage unavailable');

    expect(stored[SETTINGS_KEY]).toEqual({ showCartHistoryBtn: false, darkMode: true });
  });

  it('still saves after an earlier save failed', async () => {
    failReads = true;
    await expect(saveSetting('darkMode', true)).rejects.toThrow();
    failReads = false;

    await saveSetting('debugLogging', true);

    expect(stored[SETTINGS_KEY]).toMatchObject({ debugLogging: true });
  });
});
