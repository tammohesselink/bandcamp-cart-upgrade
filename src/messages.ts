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

// Fetches a track's audio: its start for tempo analysis, or all of it for the
// waveform. Bandcamp's stream host sends no CORS headers, so only the
// background, with the optional bcbits.com host permission, can read it.
export interface FetchAudioRequest {
  type: 'fetch-audio';
  url: string;
  bulk?: boolean;
  // The whole track (up to MAX_WHOLE_AUDIO_BYTES) instead of just its start.
  whole?: boolean;
  // Lets a CancelAudioRequest with the same ID stop the download.
  requestId?: string;
}

// Stops a fetch-audio download that is no longer wanted, e.g. the whole
// track for a waveform after skipping to the next track.
export interface CancelAudioRequest {
  type: 'cancel-audio';
  requestId: string;
}

// Reads one page of the logged-in fan's order history (the list on
// bandcamp.com/<username>/purchases), for the purchase export.
export interface OrderHistoryPageRequest {
  type: 'orderhistory-page';
  username: string;
  // The last_token of the page before, or null for the first page.
  lastToken: string | null;
  // The page's crumb for api/orderhistory/1/get_items, or the fresh one an
  // earlier page answered with. Without one, or with an expired one,
  // Bandcamp answers with a fresh crumb to retry with.
  crumb: string | null;
}

export type BcpRequest =
  | FetchRequest
  | OrderHistoryPageRequest
  | FetchAudioRequest
  | CancelAudioRequest
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

export interface FetchAudioResponse {
  // The audio file's bytes (its first ones, unless the whole track was asked
  // for), base64 encoded (messages carry JSON).
  audioBase64?: string;
  error?: string;
  // The bcbits.com permission hasn't been granted (or was taken away).
  noPermission?: boolean;
}

export interface OrderHistoryPageResponse {
  ok: boolean;
  error?: string;
  body?: unknown;
  // The crumb the page was read with, to send with the next page.
  crumb?: string | null;
}

export type BcpResponse = FetchResponse | OrderHistoryPageResponse | FetchAudioResponse | CartMutationResponse | IncognitoAccessResponse;

// Typed wrapper around chrome.runtime.sendMessage so callers get the right
// response type inferred from the request they send.
export function sendBcpMessage(msg: FetchRequest): Promise<FetchResponse>;
export function sendBcpMessage(msg: FetchAudioRequest): Promise<FetchAudioResponse>;
export function sendBcpMessage(msg: CancelAudioRequest): Promise<void>;
export function sendBcpMessage(
  msg: CartAddRequest | CartRemoveRequest | WishlistRemoveRequest | OpenIncognitoCheckoutRequest
): Promise<CartMutationResponse>;
export function sendBcpMessage(msg: OrderHistoryPageRequest): Promise<OrderHistoryPageResponse>;
export function sendBcpMessage(msg: IncognitoAccessRequest): Promise<IncognitoAccessResponse>;
export function sendBcpMessage(msg: BcpRequest): Promise<BcpResponse | void> {
  return chrome.runtime.sendMessage(msg);
}
