// The purchase export on bandcamp.com/<username>/purchases: the fan's order
// history read from Bandcamp, totals per year converted into one currency, and
// a CSV of every purchase.
//
// Taken from the purchase export in Bandcamp Tempo Adjust
// (https://github.com/azarbayejani/bandcamp-tempo-adjust), and included here so
// you don't need to install several Bandcamp extensions that do the same
// things. Copyright (c) 2022 Bobby Azarbayejani, MIT licensed: see
// THIRD_PARTY_NOTICES.md for the full notice.
//
// Conversion uses the European Central Bank's daily reference rates, served by
// frankfurter.dev as one EUR-based time series and cached in storage. The only
// thing sent to frankfurter.dev is a date range: no currency, purchase dates or
// amounts.

export interface Purchase {
  // `YYYY-MM-DD` in the browser's time zone.
  paymentDate: string;
  artist: string;
  title: string;
  url: string;
  currency: string;
  unitPrice: number;
  quantity: number;
  shipping: number;
  tax: number;
  // unitPrice × quantity + shipping + tax, in `currency`.
  totalPrice: number;
}

// `{ 'YYYY-MM-DD': { USD: 1.0892, GBP: 0.8541, ... } }`, each relative to 1 EUR.
// Only ECB business days are present.
export type RatesTable = Record<string, Record<string, number>>;

// The currencies the ECB publishes reference rates for, which covers every
// currency Bandcamp sells in.
export const CONVERTIBLE_CURRENCIES = [
  'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD',
  'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK',
  'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
];

// Local-time `YYYY-MM-DD` of a Date, or of a string Date.parse reads, such as
// Bandcamp's "19 Mar 2023 18:47:21 GMT". Null for a date that can't be read.
export function formatDate(input: Date | string): string | null {
  const date = typeof input === 'string' ? new Date(Date.parse(input)) : input;
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// One item of an api/orderhistory/1/get_items answer, or null when it has no
// readable payment date or currency.
export function parseOrderHistoryItem(raw: unknown): Purchase | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const paymentDate = typeof item.payment_date === 'string' ? formatDate(item.payment_date) : null;
  const currency = toText(item.currency).toUpperCase();
  if (!paymentDate || !currency) return null;
  const unitPrice = toNumber(item.unit_price);
  // A missing quantity is one item, as on Bandcamp's own receipts.
  const quantity = item.quantity == null ? 1 : toNumber(item.quantity);
  const shipping = toNumber(item.shipping);
  const tax = toNumber(item.tax);
  return {
    paymentDate,
    artist: toText(item.artist_name),
    title: toText(item.item_title),
    url: toText(item.item_url),
    currency,
    unitPrice,
    quantity,
    shipping,
    tax,
    totalPrice: unitPrice * quantity + shipping + tax,
  };
}

export interface OrderHistoryPage {
  purchases: Purchase[];
  // Raw items Bandcamp returned, including ones parseOrderHistoryItem skipped,
  // so an all-unreadable page doesn't look like the end of the history.
  itemCount: number;
  lastToken: string | null;
}

export function parseOrderHistoryPage(body: unknown): OrderHistoryPage {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const items = Array.isArray(record.items) ? record.items : [];
  const purchases: Purchase[] = [];
  for (const raw of items) {
    const purchase = parseOrderHistoryItem(raw);
    if (purchase) purchases.push(purchase);
  }
  return {
    purchases,
    itemCount: items.length,
    lastToken: typeof record.last_token === 'string' ? record.last_token : null,
  };
}

// --- Conversion ---------------------------------------------------------------

const DAY_MS = 86_400_000;
// Long enough to bridge Easter and the ECB's other closing days.
const MAX_RATE_LOOKBACK_DAYS = 10;

function previousDay(isoDate: string): string {
  // Date.parse reads a date-only string as UTC midnight, so no DST drift.
  return new Date(Date.parse(isoDate) - DAY_MS).toISOString().slice(0, 10);
}

// The rates in effect on `date`: that day's, or for a weekend or holiday the
// last business day before, as frankfurter's single-date endpoint resolves it.
function ratesOn(rates: RatesTable, date: string): Record<string, number> {
  let day = date;
  for (let i = 0; i <= MAX_RATE_LOOKBACK_DAYS; i++) {
    const row = rates[day];
    if (row) return row;
    day = previousDay(day);
  }
  throw new Error(`No exchange rates on or shortly before ${date}`);
}

function euroRate(row: Record<string, number>, currency: string): number {
  if (currency === 'EUR') return 1;
  const rate = row[currency];
  if (rate === undefined) throw new Error(`No exchange rate for ${currency}`);
  return rate;
}

// `amount` of `from` in `to`, at the rates of `date`. Cross rates go through
// EUR: from → to = (EUR → to) / (EUR → from).
export function convert(amount: number, from: string, to: string, rates: RatesTable, date: string): number {
  if (from === to) return amount;
  const row = ratesOn(rates, date);
  return (amount * euroRate(row, to)) / euroRate(row, from);
}

export interface ConvertedPurchase extends Purchase {
  // totalPrice in the chosen currency, or null when it couldn't be converted.
  convertedTotal: number | null;
  conversionError?: string;
}

// Each purchase with its total in `currency`. One that can't be converted keeps
// its place, so the export still lists it.
export function convertPurchases(purchases: Purchase[], rates: RatesTable | null, currency: string): ConvertedPurchase[] {
  return purchases.map((purchase) => {
    try {
      if (!rates && purchase.currency !== currency) throw new Error('Exchange rates are not available');
      return { ...purchase, convertedTotal: convert(purchase.totalPrice, purchase.currency, currency, rates ?? {}, purchase.paymentDate) };
    } catch (err) {
      return { ...purchase, convertedTotal: null, conversionError: err instanceof Error ? err.message : String(err) };
    }
  });
}

// --- Totals -------------------------------------------------------------------

export const ALL_YEARS = 'all';

export function purchaseYear(purchase: Purchase): string {
  return purchase.paymentDate.slice(0, 4);
}

// The years with purchases, newest first.
export function purchaseYears(purchases: Purchase[]): string[] {
  return Array.from(new Set(purchases.map(purchaseYear))).sort().reverse();
}

export function inYear<T extends Purchase>(purchases: T[], year: string): T[] {
  return year === ALL_YEARS ? purchases : purchases.filter((p) => purchaseYear(p) === year);
}

// The currency most purchases were paid in, the first pick for the totals.
export function mostUsedCurrency(purchases: Purchase[]): string | null {
  const counts = new Map<string, number>();
  for (const p of purchases) counts.set(p.currency, (counts.get(p.currency) ?? 0) + 1);
  let best: string | null = null;
  for (const [currency, count] of counts) {
    if (best === null || count > counts.get(best)!) best = currency;
  }
  return best;
}

export interface PurchaseTotals {
  // Sum of the converted totals, over the purchases that could be converted.
  convertedTotal: number;
  convertedCount: number;
  unconvertedCount: number;
  // What was paid in each currency, before conversion, largest count first.
  byCurrency: Array<{ currency: string; total: number; count: number }>;
}

export function totalPurchases(purchases: ConvertedPurchase[]): PurchaseTotals {
  let convertedTotal = 0;
  let convertedCount = 0;
  let unconvertedCount = 0;
  const byCurrency = new Map<string, { currency: string; total: number; count: number }>();
  for (const p of purchases) {
    if (p.convertedTotal === null) {
      unconvertedCount++;
    } else {
      convertedTotal += p.convertedTotal;
      convertedCount++;
    }
    const entry = byCurrency.get(p.currency) ?? { currency: p.currency, total: 0, count: 0 };
    entry.total += p.totalPrice;
    entry.count++;
    byCurrency.set(p.currency, entry);
  }
  return {
    convertedTotal,
    convertedCount,
    unconvertedCount,
    byCurrency: Array.from(byCurrency.values()).sort((a, b) => b.count - a.count),
  };
}

// --- CSV ----------------------------------------------------------------------

// Spreadsheet apps run a cell that starts with one of these as a formula, so a
// release title like "=HYPERLINK(...)" is written with a leading apostrophe.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value: string | number): string {
  let text = typeof value === 'number' ? String(value) : value;
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// The purchases as CSV, oldest first, with each total also in `currency`. A
// purchase that couldn't be converted has the reason in that column instead.
export function purchasesToCsv(purchases: ConvertedPurchase[], currency: string): string {
  const header = [
    'Date', 'Artist', 'Title', 'URL', 'Currency', 'Unit price', 'Quantity',
    'Shipping', 'Tax', 'Total', `Total in ${currency}`,
  ];
  const rows = [...purchases]
    .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate))
    .map((p) => [
      p.paymentDate, p.artist, p.title, p.url, p.currency,
      p.unitPrice, p.quantity, p.shipping, p.tax, roundCents(p.totalPrice),
      p.convertedTotal === null ? (p.conversionError ?? 'Not converted') : roundCents(p.convertedTotal),
    ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// --- Exchange rates -----------------------------------------------------------

export const RATES_STORAGE_KEY = 'bcp_exchange_rates_v1';
const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1';

export interface RatesCache {
  // `YYYY-MM-DD`: the first day asked for.
  startDate: string;
  // `YYYY-MM-DD`: the last day the table has rates for. The ECB publishes on
  // business days around 16:00 CET, so this can be before the day asked for.
  endDate: string;
  // `YYYY-MM-DD`: the day frankfurter was last asked for newer rates, so a
  // weekend or holiday asks once rather than on every load.
  checkedDate?: string;
  rates: RatesTable;
}

export interface RatesDeps {
  fetchRates(start: string, end: string): Promise<RatesTable>;
  readCache(): Promise<unknown>;
  writeCache(cache: RatesCache): Promise<void>;
  today: string;
}

export class FrankfurterHttpError extends Error {
  constructor(public readonly status: number) {
    super(`frankfurter.dev answered with HTTP ${status}`);
  }
}

async function fetchFrankfurterRates(start: string, end: string): Promise<RatesTable> {
  const res = await fetch(`${FRANKFURTER_URL}/${start}..${end}`);
  if (!res.ok) throw new FrankfurterHttpError(res.status);
  const body = (await res.json()) as { rates?: unknown };
  if (!body.rates || typeof body.rates !== 'object') throw new Error('frankfurter.dev answered without rates');
  return body.rates as RatesTable;
}

function defaultRatesDeps(): RatesDeps {
  return {
    fetchRates: fetchFrankfurterRates,
    readCache: async () => (await chrome.storage.local.get(RATES_STORAGE_KEY))[RATES_STORAGE_KEY],
    writeCache: (cache) => chrome.storage.local.set({ [RATES_STORAGE_KEY]: cache }),
    today: formatDate(new Date())!,
  };
}

function isRatesCache(value: unknown): value is RatesCache {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<RatesCache>;
  return typeof c.startDate === 'string' && typeof c.endDate === 'string' && !!c.rates && typeof c.rates === 'object';
}

function lastRateDay(rates: RatesTable): string | undefined {
  let last: string | undefined;
  for (const day of Object.keys(rates)) if (last === undefined || day > last) last = day;
  return last;
}

// Where the rates to load start: mid-December before the purchases' first
// year. Rounding to a year keeps the cache from refetching for every older
// purchase, and starting before January 1st (always an ECB holiday) gives a
// purchase on New Year's Day the last business day before it.
export function ratesStartFor(purchases: Purchase[]): string | null {
  let earliest: string | null = null;
  for (const p of purchases) if (earliest === null || p.paymentDate < earliest) earliest = p.paymentDate;
  return earliest === null ? null : `${Number(earliest.slice(0, 4)) - 1}-12-15`;
}

// EUR-based rates from `start` through today, fetching only what the cache
// lacks. A refresh asks again from the cache's last rate day, so no day the
// ECB published since can be skipped, and at most once a day. When the refresh
// fails the cache is used as it is: it covers every purchase but the newest.
// Storage failures don't stop rates that were fetched from being used.
export async function loadRates(start: string, deps: RatesDeps = defaultRatesDeps()): Promise<RatesTable> {
  let stored: unknown;
  try {
    stored = await deps.readCache();
  } catch {
    stored = undefined;
  }
  const cache = isRatesCache(stored) ? stored : null;
  const save = async (next: RatesCache) => {
    try {
      await deps.writeCache(next);
    } catch {
      // Uncached rates still convert this time.
    }
  };

  if (!cache || start < cache.startDate) {
    const rates = await deps.fetchRates(start, deps.today);
    await save({ startDate: start, endDate: lastRateDay(rates) ?? deps.today, checkedDate: deps.today, rates });
    return rates;
  }

  if (deps.today > cache.endDate && cache.checkedDate !== deps.today) {
    let fresh: RatesTable;
    try {
      fresh = await deps.fetchRates(cache.endDate, deps.today);
    } catch (err) {
      // A 404 means the range starts after frankfurter's latest rates (a clock
      // running ahead): the cache already has everything there is.
      if (err instanceof FrankfurterHttpError && err.status === 404) {
        await save({ ...cache, checkedDate: deps.today });
      }
      return cache.rates;
    }
    const rates = { ...cache.rates, ...fresh };
    await save({ ...cache, endDate: lastRateDay(rates) ?? cache.endDate, checkedDate: deps.today, rates });
    return rates;
  }

  return cache.rates;
}
