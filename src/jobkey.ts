import { normalizeUrl } from './url';

// Identifies a cart/discography's exact content (and order) so the content
// script and background loader can agree on whether a load job still applies
// to the current page or needs to restart. Order-sensitive: reordering the
// cart counts as a change, which is cheap to re-key since the per-release
// track cache stays warm for unchanged items.
export function computeJobKey(urls: string[]): string {
  const input = urls.map(normalizeUrl).join('\n');
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV-1a 32-bit prime
  }
  return (hash >>> 0).toString(16);
}
