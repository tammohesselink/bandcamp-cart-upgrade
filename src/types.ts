export type PlaylistId = 'currentpage' | 'cart' | 'discography';

export interface SavedCartItem {
  url: string;
  title: string;
  purchaseType?: 'track' | 'album';
}

export interface CartSnapshot {
  savedAt: number;
  items: SavedCartItem[];
}

export interface CartItem {
  url: string;
  type: 'track' | 'album' | 'unknown';
  // purchaseType is derived from "digital album" / "digital track" link text in the
  // Bandcamp sidecart. It's more reliable than the URL: album purchases can link to
  // a track URL, so URL-based detection alone would misclassify them.
  purchaseType?: 'track' | 'album';
  title: string;
  artist: string;
  thumbnailUrl: string;
  tralbumId?: number;
  tralbumType?: 't' | 'a';
  cartItemId?: string;
}

export interface PlaylistTrack {
  trackTitle: string;
  albumTitle: string;
  artist: string;
  streamUrl: string | null;
  pageUrl: string;
  artworkUrl: string;
  durationSec: number;
  unplayable: boolean;
  releaseUrl: string;
  releaseId: number | null;
  releaseType: 'track' | 'album';
  trackId: number | null;
  bandId: number | null;
  minPrice: number | null;
  trackMinPrice: number | null;
  currency: string | null;
}

// Shape of the TralbumData object embedded in Bandcamp track/album pages.
// Fields are optional because the format varies across Bandcamp page types.
export interface TralbumData {
  id?: number;
  tralbum_type?: 't' | 'a';
  band_id?: number;
  current?: {
    title?: string;
    artist?: string;
    art_id?: number;
    id?: number;
    album_id?: number | null;
    band_id?: number;
    minimum_price?: number | null;
    is_set_price?: boolean;
  };
  artist?: string;
  art_id?: number;
  album_title?: string;
  url?: string;
  trackinfo?: TrackInfo[];
}

export interface TrackInfo {
  id?: number;
  title: string;
  title_link?: string | null;
  file?: { 'mp3-128'?: string } | null;
  duration?: number | null;
  price?: number | null;
  minimum_price?: number | null;
}
