// Background-side reading of a track's audio for tempo analysis and waveforms.

// The optional host permission that lets the background read Bandcamp's
// streams. Asked for when tempo analysis or the waveform is turned on, so
// turning one of those on is the only thing that shows a new permission prompt.
export const AUDIO_HOST_PERMISSION = 'https://*.bcbits.com/*';

// About 2.5 minutes of Bandcamp's 128 kbps streams: as much as the analysis
// uses (ANALYSIS_MAX_SECONDS), plus room for a tag with artwork at the start.
export const MAX_AUDIO_BYTES = 2_600_000;

// About half an hour of Bandcamp's 128 kbps streams, for a waveform: every
// track whole, and the first half hour of a long mix. Base64 encoded it stays
// well inside the 64 MB a message between extension pages can carry.
export const MAX_WHOLE_AUDIO_BYTES = 30_000_000;

// Stream links are on *.bcbits.com, or on bandcamp.com and redirect there.
export function isStreamUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    return url.hostname.endsWith('.bcbits.com') || url.hostname === 'bandcamp.com' || url.hostname.endsWith('.bandcamp.com');
  } catch {
    return false;
  }
}

// Reads at most `maxBytes` of a response body, and stops the download there.
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer()).subarray(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  if (length >= maxBytes) reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(length, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.length) break;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
