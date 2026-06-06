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

export type BcpRequest = FetchRequest | CartAddRequest | CartRemoveRequest | OpenIncognitoCheckoutRequest;

export interface FetchResponse {
  html?: string;
  error?: string;
}

export interface CartMutationResponse {
  ok: boolean;
  error?: string;
  body?: unknown;
}

export type BcpResponse = FetchResponse | CartMutationResponse;

// Typed wrapper around chrome.runtime.sendMessage so callers get the right
// response type inferred from the request they send.
export function sendBcpMessage(msg: FetchRequest): Promise<FetchResponse>;
export function sendBcpMessage(
  msg: CartAddRequest | CartRemoveRequest | OpenIncognitoCheckoutRequest
): Promise<CartMutationResponse>;
export function sendBcpMessage(msg: BcpRequest): Promise<BcpResponse> {
  return chrome.runtime.sendMessage(msg);
}
