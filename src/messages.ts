// Typed protocol for messages between the content script and the background
// service worker. Keeping the request/response shapes in one place lets both
// sides share the types instead of casting `any` at every call site.

export interface FetchRequest {
  type: 'fetch';
  url: string;
}

export interface CartAddRequest {
  type: 'cart-add';
  tralbumId: number | null;
  tralbumType: 't' | 'a';
  minPrice: number | null;
  bandId: number | null;
  releaseUrl: string;
  syncNum: number;
  clientId: string;
  fanId: string;
  countryCode: string;
  cartLength: number;
}

export interface CartRemoveRequest {
  type: 'cart-remove';
  tralbumId: number | null;
  releaseUrl: string;
  syncNum: number;
  clientId: string;
  fanId: string;
}

export interface OpenIncognitoCheckoutRequest {
  type: 'open-incognito-checkout';
  // Pre-resolved track data from the normal window's warm cache.
  // Short keys to keep the URL hash compact when many items are passed.
  // u=releaseUrl, id=tralbumId, t=tralbumType, pr=minPrice, b=bandId
  items: Array<{ u: string; id: number; t: 't' | 'a'; pr: number; b: number | null }>;
}

// A cart/discography release, trimmed to the fields the background loader
// needs (title/artist are only used for cache-viewer failure display).
export interface LoadItem {
  url: string;
  title: string;
  artist: string;
}

export type LoadLabel = 'cart' | 'discography';
export type JobStatus = 'running' | 'done' | 'empty';

export interface EnsureLoadRequest {
  type: 'ensure-load';
  label: LoadLabel;
  // Hash of the ordered, normalized item URLs — identifies this exact
  // cart/discography content so the background loader can tell whether a
  // running or persisted job still applies, or whether the content changed
  // and loading needs to restart (re-using cache for unchanged releases).
  jobKey: string;
  items: LoadItem[];
}

export type BcpRequest =
  | FetchRequest
  | CartAddRequest
  | CartRemoveRequest
  | OpenIncognitoCheckoutRequest
  | EnsureLoadRequest;

export interface FetchResponse {
  html?: string;
  error?: string;
}

export interface CartMutationResponse {
  ok: boolean;
  error?: string;
  body?: unknown;
}

export interface EnsureLoadResponse {
  ok: boolean;
  status: JobStatus;
}

export type BcpResponse = FetchResponse | CartMutationResponse | EnsureLoadResponse;

// Typed wrapper around chrome.runtime.sendMessage so callers get the right
// response type inferred from the request they send.
export function sendBcpMessage(msg: FetchRequest): Promise<FetchResponse>;
export function sendBcpMessage(
  msg: CartAddRequest | CartRemoveRequest | OpenIncognitoCheckoutRequest
): Promise<CartMutationResponse>;
export function sendBcpMessage(msg: EnsureLoadRequest): Promise<EnsureLoadResponse>;
export function sendBcpMessage(msg: BcpRequest): Promise<BcpResponse> {
  return chrome.runtime.sendMessage(msg);
}
