export type PlaylistId = 'cart' | 'discography';

export interface CartItem {
  url: string;
  type: 'track' | 'album' | 'unknown';
  title: string;
  artist: string;
  thumbnailUrl: string;
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
}

// Shape of the TralbumData object embedded in Bandcamp track/album pages.
// Fields are optional because the format varies across Bandcamp page types.
export interface TralbumData {
  current?: {
    title?: string;
    artist?: string;
    art_id?: number;
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
}
