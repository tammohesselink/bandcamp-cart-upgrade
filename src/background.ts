import type { BcpRequest, EnsureLoadRequest, EnsureLoadResponse, FetchResponse, LoadItem, LoadLabel } from './messages';
import { parseTralbum } from './bandcamp';
import { readCacheBatch, writeCache } from './cache';
import { PAUSE_FLAG_KEY, readProgress, writeProgress, type JobFailure, type JobProgress } from './progress';

// Returns the https origin for a Bandcamp URL, or null if the URL isn't a valid
// https://*.bandcamp.com address. Used to refuse proxying credentialed requests
// to arbitrary hosts.
function bandcampOrigin(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return null;
    if (u.hostname !== 'bandcamp.com' && !u.hostname.endsWith('.bandcamp.com')) return null;
    return u.origin;
  } catch {
    return null;
  }
}

// Shared by the one-off 'fetch' message handler and the resumable job loader
// below, so both paths refuse non-bandcamp URLs and format errors the same way.
async function fetchBandcampHtml(url: string): Promise<FetchResponse> {
  if (!bandcampOrigin(url)) {
    return { error: 'Refused: not a bandcamp.com URL' };
  }
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { html: await res.text() };
  } catch (err) {
    return { error: String(err) };
  }
}

// --- Resumable cart/discography metadata loader -----------------------------
//
// Runs the sequential fetch → parse → cache loop that used to live in the
// content script (resolvePlaylist). Moving it here means it survives page
// navigation: an active `fetch` keeps this service worker alive through the
// gap, and if the worker is evicted anyway, persisted progress (`doneUrls`)
// plus the per-release cache make the next `ensure-load` resume almost
// instantly instead of restarting from item 0.

interface Job {
  key: string;
  label: LoadLabel;
  items: LoadItem[];
  cancelled: boolean;
}

const jobs = new Map<LoadLabel, Job>();

function recordFailure(failures: JobFailure[], item: LoadItem, reason: JobFailure['reason']): JobFailure[] {
  return [...failures.filter((f) => f.url !== item.url), { url: item.url, title: item.title, artist: item.artist, reason }];
}

function clearFailure(failures: JobFailure[], url: string): JobFailure[] {
  return failures.filter((f) => f.url !== url);
}

async function persistProgress(
  job: Job,
  done: Set<string>,
  failures: JobFailure[],
  processed: number,
  currentUrl: string | null,
  status: JobProgress['status']
): Promise<void> {
  await writeProgress({
    jobKey: job.key,
    label: job.label,
    total: job.items.length,
    processed,
    doneUrls: job.items.filter((i) => done.has(i.url)).map((i) => i.url),
    failures,
    currentUrl,
    status,
    updatedAt: Date.now(),
  });
}

async function runJob(job: Job, seedDone: Set<string>, seedFailures: JobFailure[]): Promise<void> {
  const done = new Set(seedDone);
  // Drop any seeded failure for a URL no longer in this job's items (cart changed).
  let failures = seedFailures.filter((f) => job.items.some((i) => i.url === f.url));

  const batch = await readCacheBatch(job.items.map((i) => i.url));

  for (let i = 0; i < job.items.length; i++) {
    if (job.cancelled) return;
    await waitWhilePaused();
    if (job.cancelled) return;

    const item = job.items[i]!;

    if (!done.has(item.url)) {
      let tracks = batch.get(item.url) ?? null;
      if (tracks) {
        failures = clearFailure(failures, item.url);
      } else {
        const response = await fetchBandcampHtml(item.url);
        if (response.error) {
          console.warn(`[bcp] Fetch error for ${item.url}:`, response.error);
          failures = recordFailure(failures, item, 'error');
        } else {
          const parsed = parseTralbum(response.html ?? '', item.url);
          if (parsed.length === 0) {
            console.warn('[bcp] No tracks parsed from', item.url);
            failures = recordFailure(failures, item, 'empty');
          } else {
            tracks = parsed;
            writeCache(item.url, parsed);
            failures = clearFailure(failures, item.url);
          }
        }
      }
      if (tracks) done.add(item.url);
    }

    await persistProgress(job, done, failures, i + 1, item.url, 'running');
  }

  if (job.cancelled) return;
  await persistProgress(job, done, failures, job.items.length, null, 'done');
  if (jobs.get(job.label) === job) jobs.delete(job.label);
}

async function handleEnsureLoad(req: EnsureLoadRequest): Promise<EnsureLoadResponse> {
  const { label, jobKey, items } = req;

  if (items.length === 0) {
    await persistProgress({ key: jobKey, label, items: [], cancelled: false }, new Set(), [], 0, null, 'empty');
    return { ok: true, status: 'empty' };
  }

  const existing = jobs.get(label);
  if (existing && existing.key === jobKey && !existing.cancelled) {
    return { ok: true, status: 'running' };
  }

  const persisted = await readProgress(label);
  const matchesPersisted = persisted?.jobKey === jobKey;
  if (matchesPersisted && persisted!.status === 'done') {
    return { ok: true, status: 'done' };
  }

  // A stale job for this label (different cart content, or content that
  // changed after this job started) is superseded — let it notice `cancelled`
  // and stop on its next loop check.
  if (existing) existing.cancelled = true;

  const job: Job = { key: jobKey, label, items, cancelled: false };
  jobs.set(label, job);

  const seedDone = matchesPersisted ? new Set(persisted!.doneUrls) : new Set<string>();
  const seedFailures = matchesPersisted ? persisted!.failures : [];

  runJob(job, seedDone, seedFailures).catch((err: unknown) => {
    console.error('[bcp] Load job failed:', label, err);
  });

  return { ok: true, status: 'running' };
}

// --- Debug pause/resume gate --------------------------------------------------
// Backed by a storage flag (rather than in-memory state) so pausing survives
// this worker being evicted and restarted, and so multiple job loops
// (cart + discography) observe the same flag via one onChanged listener.

let pauseWaiters: Array<() => void> = [];

async function isPaused(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(PAUSE_FLAG_KEY);
    return result[PAUSE_FLAG_KEY] === true;
  } catch {
    return false;
  }
}

async function waitWhilePaused(): Promise<void> {
  if (!(await isPaused())) return;
  return new Promise((resolve) => pauseWaiters.push(resolve));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const change = changes[PAUSE_FLAG_KEY];
  if (change && change.newValue !== true) {
    const waiters = pauseWaiters;
    pauseWaiters = [];
    waiters.forEach((fn) => fn());
  }
});

// -----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: BcpRequest, sender, sendResponse) => {
  // Only act on messages from this extension's own content scripts/pages.
  if (sender.id !== chrome.runtime.id) return false;

  if (message.type === 'fetch') {
    fetchBandcampHtml(message.url).then(sendResponse);
    return true; // keep message channel open for async response
  }

  if (message.type === 'ensure-load') {
    handleEnsureLoad(message).then(sendResponse);
    return true;
  }

  if (message.type === 'cart-remove') {
    // Endpoint: POST {artist}.bandcamp.com/cart/cb
    // Body fields captured via DevTools: req=del, id, client_id, sync_num, req_id
    const origin = bandcampOrigin(message.releaseUrl);
    if (!origin) {
      sendResponse({ ok: false, error: 'Invalid releaseUrl' });
      return false;
    }

    const body = new URLSearchParams({
      req: 'del',
      id: String(message.tralbumId),
      fan_id: message.fanId,
      client_id: message.clientId,
      sync_num: String(message.syncNum),
      req_id: crypto.randomUUID(),
    });

    fetch(`${origin}/cart/cb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body: body.toString(),
    })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP ${res.status}` });
          return;
        }
        let json: unknown;
        try { json = await res.json(); } catch { json = null; }
        // Bandcamp returns an error string in the `error` field on failure (HTTP 200).
        if (json && typeof json === 'object' && 'error' in json && (json as Record<string, unknown>).error) {
          sendResponse({ ok: false, error: String((json as Record<string, unknown>).error), body: json });
          return;
        }
        sendResponse({ ok: true, body: json });
      })
      .catch((err: unknown) => {
        sendResponse({ ok: false, error: String(err) });
      });

    return true;
  }

  if (message.type === 'open-incognito-checkout') {
    // Open a private window at the Bandcamp cart page, passing the selected
    // items in the URL hash so the content script can add them to the fresh
    // incognito cart and proceed to checkout. chrome.windows.create throws if
    // the user hasn't enabled "Allow in incognito" for the extension.
    const payload = encodeURIComponent(JSON.stringify(message.items));
    const url = `https://bandcamp.com/cart#bcp_cart=${payload}`;
    chrome.windows.create({ url, incognito: true })
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === 'cart-add') {
    // Endpoint: POST {artist}.bandcamp.com/cart/cb
    // Body fields mirror Bandcamp's own add-to-cart request (captured via DevTools).
    const origin = bandcampOrigin(message.releaseUrl);
    if (!origin) {
      sendResponse({ ok: false, error: 'Invalid releaseUrl' });
      return false;
    }

    const body = new URLSearchParams({
      req: 'add',
      local_id: crypto.randomUUID(),
      item_type: message.tralbumType,
      item_id: String(message.tralbumId),
      unit_price: String(message.minPrice ?? 0),
      quantity: '1',
      band_id: String(message.bandId ?? ''),
      ip_country_code: message.countryCode,
      is_cardable: 'true',
      cart_length: String(message.cartLength),
      fan_id: message.fanId,
      client_id: message.clientId,
      sync_num: String(message.syncNum),
      req_id: crypto.randomUUID(),
    });

    fetch(`${origin}/cart/cb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body: body.toString(),
    })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP ${res.status}` });
          return;
        }
        let json: unknown;
        try { json = await res.json(); } catch { json = null; }
        if (json && typeof json === 'object' && 'error' in json && (json as Record<string, unknown>).error) {
          sendResponse({ ok: false, error: String((json as Record<string, unknown>).error), body: json });
          return;
        }
        sendResponse({ ok: true, body: json });
      })
      .catch((err: unknown) => {
        sendResponse({ ok: false, error: String(err) });
      });

    return true;
  }

  return false;
});
