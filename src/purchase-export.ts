// The purchase export panel above the order list on
// bandcamp.com/<username>/purchases: what was spent per year, in one currency,
// and a CSV of every purchase. Nothing is fetched until "Load purchases".
//
// Taken from Bandcamp Tempo Adjust, Copyright (c) 2022 Bobby Azarbayejani,
// MIT licensed: see THIRD_PARTY_NOTICES.md.

import {
  ALL_YEARS,
  CONVERTIBLE_CURRENCIES,
  convertPurchases,
  formatDate,
  inYear,
  loadRates,
  mostUsedCurrency,
  parseOrderHistoryPage,
  purchaseYears,
  purchasesToCsv,
  ratesStartFor,
  totalPurchases,
  type Purchase,
  type RatesTable,
} from './purchases';
import { readOrderHistoryContext, readPageCrumb } from './bandcamp-dom';
import { sendBcpMessage } from './messages';
import { log } from './log';

const PANEL_ID = 'bcp-purchase-export';
const STYLE_ID = 'bcp-purchase-export-styles';
const CRUMB_ENDPOINT = 'api/orderhistory/1/get_items';
// One page a second, as Bandcamp's own page does when scrolled, to stay well
// clear of its rate limiting.
const PAGE_INTERVAL_MS = 1000;
// A history longer than this many pages means the token isn't advancing.
const MAX_PAGES = 5000;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PANEL_ID}{background:#fff;border:1px solid #e8e8e8;margin:24px 0;font-size:13px;line-height:1.5;color:#333}
    #${PANEL_ID} .bcp-purchase-export-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:14px 16px;border-top:1px solid #e8e8e8}
    #${PANEL_ID} .bcp-purchase-export-row:first-child{border-top:none}
    #${PANEL_ID} .bcp-purchase-export-header{flex-direction:column;align-items:flex-start;gap:2px}
    #${PANEL_ID} .bcp-purchase-export-eyebrow{font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.04em}
    #${PANEL_ID} h2{margin:0;font-size:16px;font-weight:bold}
    #${PANEL_ID} label{display:inline-flex;align-items:center;gap:6px}
    #${PANEL_ID} select{font:inherit;padding:2px 4px}
    #${PANEL_ID} .bcp-purchase-export-button{padding:4px 12px;border-radius:4px;border:1px solid #1da0c3;color:#1da0c3;background:none;cursor:pointer;font:inherit}
    #${PANEL_ID} .bcp-purchase-export-button:hover:not(:disabled){background:#e8f7fb}
    #${PANEL_ID} .bcp-purchase-export-button:disabled{opacity:.5;cursor:default}
    #${PANEL_ID} .bcp-purchase-export-total{font-size:18px;font-weight:bold}
    #${PANEL_ID} .bcp-purchase-export-muted{color:#777}
    #${PANEL_ID} .bcp-purchase-export-warning{color:#a15c00}
    #${PANEL_ID} .bcp-purchase-export-error{color:#c0392b}
    #${PANEL_ID} .bcp-purchase-export-grow{flex:1}
  `;
  document.head.appendChild(style);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(label: string, value: string): HTMLOptionElement {
  const node = el('option', undefined, label);
  node.value = value;
  return node;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Where loading the order history has got to. Kept across "Try again", so a
// failure after many pages carries on from the page that failed.
interface OrderHistoryProgress {
  purchases: Purchase[];
  crumb: string | null;
  lastToken: string | null;
  seenTokens: Set<string>;
  pagesLoaded: number;
}

// Waits before each retry of a page that failed, such as a rate-limited one.
const RETRY_DELAYS_MS = [2000, 5000, 15000];

// Loads the rest of the fan's order history into `progress`, page by page.
async function loadAllPurchases(
  username: string,
  progress: OrderHistoryProgress,
  onProgress: (loaded: number) => void,
): Promise<Purchase[]> {
  while (progress.pagesLoaded < MAX_PAGES) {
    if (progress.pagesLoaded > 0) await sleep(PAGE_INTERVAL_MS);
    let res = await sendBcpMessage({ type: 'orderhistory-page', username, lastToken: progress.lastToken, crumb: progress.crumb });
    for (const delay of RETRY_DELAYS_MS) {
      if (res.ok) break;
      log.warn('[bcp] purchase export: order history page failed, retrying', res.error);
      await sleep(delay);
      res = await sendBcpMessage({ type: 'orderhistory-page', username, lastToken: progress.lastToken, crumb: progress.crumb });
    }
    if (!res.ok) throw new Error(res.error ?? 'Bandcamp did not return the order history');
    if (res.crumb) progress.crumb = res.crumb;
    const parsed = parseOrderHistoryPage(res.body);
    progress.purchases.push(...parsed.purchases);
    progress.pagesLoaded++;
    onProgress(progress.purchases.length);
    if (parsed.itemCount === 0 || parsed.lastToken === null || progress.seenTokens.has(parsed.lastToken)) break;
    progress.seenTokens.add(parsed.lastToken);
    progress.lastToken = parsed.lastToken;
  }
  return progress.purchases;
}

function downloadCsv(csv: string, filename: string): void {
  // The byte order mark makes Excel read the file as UTF-8.
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = el('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link); // Firefox only follows links in the document.
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function injectPurchaseExport(): void {
  if (document.getElementById(PANEL_ID)) return;
  const list = document.querySelector('.purchases');
  const context = readOrderHistoryContext();
  if (!list || !context) return;
  ensureStyles();

  const panel = el('div');
  panel.id = PANEL_ID;
  const header = el('div', 'bcp-purchase-export-row bcp-purchase-export-header');
  // The panel sits inside Bandcamp's page, so it says which extension added it.
  header.append(el('div', 'bcp-purchase-export-eyebrow', 'Bandcamp Cart Upgrade'), el('h2', undefined, 'Purchase export'));
  const body = el('div');
  panel.append(header, body);
  list.before(panel);

  const showStart = (error?: string) => {
    const row = el('div', 'bcp-purchase-export-row');
    const intro = el('span', 'bcp-purchase-export-grow', "See how much you've spent on Bandcamp per year, or export all your purchases as a CSV.");
    const button = el('button', 'bcp-purchase-export-button', error ? 'Try again' : 'Load purchases');
    button.type = 'button';
    button.addEventListener('click', () => void start());
    row.append(intro, button);
    body.replaceChildren(row);
    if (error) body.append(el('div', 'bcp-purchase-export-row bcp-purchase-export-error', error));
  };

  const historyProgress: OrderHistoryProgress = {
    purchases: [],
    crumb: readPageCrumb(CRUMB_ENDPOINT),
    lastToken: null,
    seenTokens: new Set(),
    pagesLoaded: 0,
  };

  const start = async () => {
    const progress = el('div', 'bcp-purchase-export-row bcp-purchase-export-muted', 'Loading purchases…');
    body.replaceChildren(progress);
    let purchases: Purchase[];
    try {
      purchases = await loadAllPurchases(context.username, historyProgress, (loaded) => {
        const of = context.totalItems ? ` of about ${context.totalItems}` : '';
        progress.textContent = `Loading purchases… ${loaded}${of} (this can take a while)`;
      });
    } catch (err) {
      log.error('[bcp] purchase export: loading the order history failed', err);
      const kept = historyProgress.purchases.length > 0
        ? ` The ${historyProgress.purchases.length} purchases loaded so far are kept; trying again carries on from there.`
        : '';
      showStart(`Could not load your purchases from Bandcamp: ${err instanceof Error ? err.message : String(err)}.${kept}`);
      return;
    }
    if (purchases.length === 0) {
      body.replaceChildren(el('div', 'bcp-purchase-export-row bcp-purchase-export-muted', 'No purchases found.'));
      return;
    }

    let rates: RatesTable | null = null;
    let ratesError: string | null = null;
    const ratesStart = ratesStartFor(purchases)!;
    progress.textContent = `Loaded ${purchases.length} purchases. Loading exchange rates…`;
    try {
      rates = await loadRates(ratesStart);
    } catch (err) {
      log.error('[bcp] purchase export: loading exchange rates failed', err);
      ratesError = err instanceof Error ? err.message : String(err);
    }
    showTotals(purchases, rates, ratesError);
  };

  const showTotals = (purchases: Purchase[], rates: RatesTable | null, ratesError: string | null) => {
    const years = purchaseYears(purchases);
    const thisYear = String(new Date().getFullYear());
    let year = years.includes(thisYear) ? thisYear : ALL_YEARS;
    const mostUsed = mostUsedCurrency(purchases);
    let currency = mostUsed && CONVERTIBLE_CURRENCIES.includes(mostUsed) ? mostUsed : 'USD';

    const controls = el('div', 'bcp-purchase-export-row');
    const yearSelect = el('select');
    yearSelect.append(option('All time', ALL_YEARS), ...years.map((y) => option(y, y)));
    yearSelect.value = year;
    const currencySelect = el('select');
    // Only currencies with ECB rates: anything else could convert just the
    // purchases paid in it.
    const currencies = CONVERTIBLE_CURRENCIES;
    currencySelect.append(...currencies.map((c) => option(c, c)));
    currencySelect.value = currency;
    const yearLabel = el('label', undefined, 'Year');
    yearLabel.append(yearSelect);
    const currencyLabel = el('label', undefined, 'Currency');
    currencyLabel.append(currencySelect);
    const exportButton = el('button', 'bcp-purchase-export-button', 'Export CSV');
    exportButton.type = 'button';
    controls.append(yearLabel, currencyLabel, el('span', 'bcp-purchase-export-grow'), exportButton);

    const summary = el('div');
    const note = el('div', 'bcp-purchase-export-row bcp-purchase-export-muted');
    note.append(
      'Totals are approximate: each purchase is converted at the European Central Bank rate of its payment date, from ',
      Object.assign(el('a', undefined, 'frankfurter.dev'), { href: 'https://frankfurter.dev', target: '_blank', rel: 'noreferrer' }),
      '. The CSV lists every purchase in the selected year with its original amounts.',
    );
    body.replaceChildren(controls, summary, note);

    const render = () => {
      const converted = convertPurchases(inYear(purchases, year), rates, currency);
      const totals = totalPurchases(converted);
      const rows: HTMLElement[] = [];

      const totalRow = el('div', 'bcp-purchase-export-row');
      const label = year === ALL_YEARS ? 'All time' : year;
      totalRow.append(
        el('span', 'bcp-purchase-export-total', `${label}: ${formatMoney(totals.convertedTotal, currency)}`),
        el('span', 'bcp-purchase-export-muted', `${converted.length} purchase${converted.length === 1 ? '' : 's'}`),
      );
      rows.push(totalRow);

      if (totals.byCurrency.length > 1 || totals.byCurrency[0]?.currency !== currency) {
        const paid = totals.byCurrency
          .map((c) => `${formatMoney(c.total, c.currency)} (${c.count})`)
          .join(' · ');
        rows.push(el('div', 'bcp-purchase-export-row bcp-purchase-export-muted', `Paid: ${paid}`));
      }
      if (ratesError) {
        rows.push(el('div', 'bcp-purchase-export-row bcp-purchase-export-error', `Could not load exchange rates (${ratesError}), so only purchases paid in ${currency} are in the total.`));
      } else if (totals.unconvertedCount > 0) {
        rows.push(el('div', 'bcp-purchase-export-row bcp-purchase-export-warning',
          `${totals.unconvertedCount} of ${converted.length} purchases could not be converted to ${currency}. ` +
          'They are left out of the total but are in the CSV.'));
      }
      summary.replaceChildren(...rows);
      return converted;
    };

    let converted = render();
    yearSelect.addEventListener('change', () => { year = yearSelect.value; converted = render(); });
    currencySelect.addEventListener('change', () => { currency = currencySelect.value; converted = render(); });
    exportButton.addEventListener('click', () => {
      const span = year === ALL_YEARS ? 'all-time' : year;
      downloadCsv(purchasesToCsv(converted, currency), `bandcamp-purchases-${span}-${formatDate(new Date())}.csv`);
    });
  };

  showStart();
}
