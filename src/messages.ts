// Typed protocol for messages between the content script and the background
// service worker. Keeping the request/response shapes in one place lets both
// sides share the types instead of casting `any` at every call site.

export interface FetchRequest {
  type: 'fetch';
  url: string;
  // Part of loading a whole playlist; waits behind fetches someone is waiting on.
  bulk?: boolean;
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

// Takes a release or track off the fan's wishlist. Fields as Bandcamp's own
// "in wishlist" toggle sends them to uncollect_item_cb.
export interface WishlistRemoveRequest {
  type: 'wishlist-remove';
  // The wished-for item's page, whose origin the request goes to.
  releaseUrl: string;
  itemId: number;
  itemType: 'album' | 'track';
  bandId: number;
  fanId: string;
  // The page's crumb for uncollect_item_cb, when it has one. Without one, or
  // with an expired one, Bandcamp answers with a fresh crumb to retry with.
  crumb: string | null;
}

export interface OpenIncognitoCheckoutRequest {
  type: 'open-incognito-checkout';
  // Pre-resolved track data from the normal window's warm cache.
  // Short keys to keep the URL hash compact when many items are passed.
  // u=releaseUrl, id=tralbumId, t=tralbumType, pr=minPrice, b=bandId
  items: Array<{ u: string; id: number; t: 't' | 'a'; pr: number; b: number | null }>;
}

// Whether "Allow in incognito" is on for the extension. Only the background
// can ask; content scripts have no access to that API.
export interface IncognitoAccessRequest {
  type: 'incognito-access';
}

export type BcpRequest =
  | FetchRequest
  | CartAddRequest
  | CartRemoveRequest
  | WishlistRemoveRequest
  | OpenIncognitoCheckoutRequest
  | IncognitoAccessRequest;

export interface FetchResponse {
  html?: string;
  error?: string;
}

export interface CartMutationResponse {
  ok: boolean;
  error?: string;
  body?: unknown;
}

export interface IncognitoAccessResponse {
  allowed: boolean;
}

export type BcpResponse = FetchResponse | CartMutationResponse | IncognitoAccessResponse;

// Typed wrapper around chrome.runtime.sendMessage so callers get the right
// response type inferred from the request they send.
export function sendBcpMessage(msg: FetchRequest): Promise<FetchResponse>;
export function sendBcpMessage(
  msg: CartAddRequest | CartRemoveRequest | WishlistRemoveRequest | OpenIncognitoCheckoutRequest
): Promise<CartMutationResponse>;
export function sendBcpMessage(msg: IncognitoAccessRequest): Promise<IncognitoAccessResponse>;
export function sendBcpMessage(msg: BcpRequest): Promise<BcpResponse> {
  return chrome.runtime.sendMessage(msg);
}
