import type { Player } from './player';
import type { PlaylistTrack } from './types';
import { normalizeUrl } from './url';
import { SEL_NATIVE_TRACK_TABLE, SEL_NATIVE_TRACK_ROW, SEL_NATIVE_ROW_PLAY } from './bandcamp-dom';

// How long native pause events are put down to a row we clicked, in case
// Bandcamp never plays that row.
const ROW_SWITCH_TIMEOUT_MS = 2000;
// The browser fires 'seeked' on the native audio when a track starts (seeking
// to 0:00), which must not jump the bottom player back to the beginning.
const SEEK_SYNC_GRACE_MS = 500;
// Positions this close count as the same.
const POSITION_TOLERANCE_SEC = 1;

// Keeps Bandcamp's own player, muted, in step with the bottom player on the
// Current page tab, and lets its buttons and track rows drive the bottom player.
//
// The bottom player makes the sound, so its state wins: after every change,
// reconcile() puts the native player on the bottom player's track and play
// state. A native event only counts as the user's when it disagrees with that
// state and is not the echo of something reconcile() did. Comparing state,
// rather than ignoring events for a fixed time, means an event that arrives
// earlier or later than expected cannot leave the two players apart.
//
// Returns a teardown callback to be registered with the pagehide event.
export function setupNativePlayerSync(player: Player): () => void {
  // Bandcamp's audio element lives in the DOM; the bottom player's elements
  // are never inserted, so this always finds the native one (or null).
  const getNativeAudio = (): HTMLAudioElement | null =>
    document.querySelector<HTMLAudioElement>('audio');

  let attachedAudio: HTMLAudioElement | null = null;
  // The play or pause last asked of the native audio, until its event arrives.
  let expectedEvent: 'play' | 'pause' | null = null;
  // Running while a native row we clicked has not started playing yet.
  let rowSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  // The native audio finished its track before the bottom player did, and
  // Bandcamp moved on to the next row. That row waits, paused, until the
  // bottom player gets to it, instead of cutting the bottom player's track short.
  let nativeAhead = false;
  let ignoreSeekedUntil = 0;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  const rowPageUrl = (row: HTMLElement): string | null => {
    const a = row.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
    return a ? new URL(a.href, location.href).href : null;
  };

  const currentRow = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(`${SEL_NATIVE_TRACK_ROW}.current_track`);

  const rowFor = (pageUrl: string): HTMLElement | undefined =>
    Array.from(document.querySelectorAll<HTMLElement>(SEL_NATIVE_TRACK_ROW)).find((row) => {
      const url = rowPageUrl(row);
      return url !== null && normalizeUrl(url) === normalizeUrl(pageUrl);
    });

  // The Current page track the bottom player is playing or about to, if any.
  const dockTrack = (): PlaylistTrack | null =>
    player.currentPlaylistId === 'currentpage' && player.isPlayingOrPending
      ? player.getActiveTrack('currentpage')
      : null;

  const playNative = (audio: HTMLAudioElement) => {
    if (!audio.paused) return;
    expectedEvent = 'play';
    audio.play().catch(() => {
      if (expectedEvent === 'play') expectedEvent = null;
    });
  };

  const pauseNative = (audio: HTMLAudioElement) => {
    if (audio.paused) return;
    expectedEvent = 'pause';
    audio.pause();
  };

  const clickRow = (row: HTMLElement) => {
    if (rowSwitchTimer !== null) clearTimeout(rowSwitchTimer);
    rowSwitchTimer = setTimeout(() => { rowSwitchTimer = null; }, ROW_SWITCH_TIMEOUT_MS);
    (row.querySelector<HTMLElement>(SEL_NATIVE_ROW_PLAY) ?? row).click();
  };

  // Returns whether a row switch was in progress.
  const endRowSwitch = (): boolean => {
    if (rowSwitchTimer === null) return false;
    clearTimeout(rowSwitchTimer);
    rowSwitchTimer = null;
    return true;
  };

  const reconcile = () => {
    reconcileTimer = null;
    const audio = attachedAudio;
    const track = dockTrack();
    if (!track) {
      nativeAhead = false;
      if (audio) pauseNative(audio);
      return;
    }
    if (nativeAhead) {
      if (audio) pauseNative(audio);
      return;
    }
    // The native audio playing the clicked row reconciles again.
    if (rowSwitchTimer !== null) return;
    const row = rowFor(track.pageUrl);
    // Without a source of its own the native player only starts from a row.
    if (row && (row !== currentRow() || !audio?.currentSrc)) {
      clickRow(row);
      return;
    }
    if (audio) playNative(audio);
  };

  // Deferred to the next task, so it sees the bottom player after it has
  // finished a change, e.g. after 'ended' has moved on and started the next track.
  const scheduleReconcile = () => {
    reconcileTimer ??= setTimeout(reconcile, 0);
  };

  // --- native → bottom: native started playing ---
  const onNativePlay = (event: Event) => {
    const audio = event.currentTarget as HTMLAudioElement;
    const echo = expectedEvent === 'play';
    if (echo) expectedEvent = null;
    const switched = endRowSwitch();
    ignoreSeekedUntil = Date.now() + SEEK_SYNC_GRACE_MS;
    if (echo || switched || audio.paused) {
      scheduleReconcile();
      return;
    }
    if (nativeAhead && dockTrack()) {
      pauseNative(audio);
      return;
    }

    const row = currentRow();
    const pageUrl = row ? rowPageUrl(row) : null;
    const tracks = player.getPlaylistTracks('currentpage');
    const found = pageUrl ? tracks.findIndex((t) => normalizeUrl(t.pageUrl) === normalizeUrl(pageUrl)) : -1;
    const index = found === -1 ? 0 : found;
    if (dockTrack() === tracks[index]) return;
    nativeAhead = false;
    // silent=true: native is already on the right track — don't drive it again.
    player.jumpTo('currentpage', index, true);
    // The bottom player plays from where it has the track, e.g. 0:00 when it
    // was playing another tab; show the same position natively.
    if (Math.abs(audio.currentTime - player.currentTime) > POSITION_TOLERANCE_SEC) {
      audio.currentTime = player.currentTime;
    }
  };

  // --- native → bottom: native paused ---
  const onNativePause = (event: Event) => {
    const audio = event.currentTarget as HTMLAudioElement;
    const echo = expectedEvent === 'pause';
    if (echo) expectedEvent = null;
    // Reaching the end of a track pauses it before Bandcamp moves to the next row.
    if (audio.ended) {
      if (dockTrack()) nativeAhead = true;
      return;
    }
    if (echo || rowSwitchTimer !== null || !audio.paused) {
      scheduleReconcile();
      return;
    }
    // While the tab is in the background, Chrome suspends the muted native
    // audio and fires 'pause'. That is not the user pausing: reconcile resumes
    // it (muted autoplay is allowed regardless of tab visibility) so the native
    // button keeps showing "playing".
    if (document.hidden) {
      scheduleReconcile();
      return;
    }
    if (dockTrack()) player.pause();
  };

  // Registered as a capturing listener so it runs before Bandcamp's own, which
  // moves on to the next row.
  const onNativeEnded = () => {
    if (dockTrack()) nativeAhead = true;
  };

  // --- tab regains visibility: re-sync in case the background resume didn't stick ---
  const onVisibilityChange = () => {
    if (!document.hidden) scheduleReconcile();
  };

  // --- native → bottom: seek sync ---
  const onNativeSeeked = (event: Event) => {
    const audio = event.currentTarget as HTMLAudioElement;
    if (Date.now() < ignoreSeekedUntil) return;
    if (player.currentPlaylistId !== 'currentpage') return;
    if (!isFinite(audio.duration)) return;
    // Seeks made by onSeek below arrive here too, already in step.
    if (Math.abs(audio.currentTime - player.currentTime) <= POSITION_TOLERANCE_SEC) return;
    player.seekToFraction(audio.currentTime / audio.duration);
  };

  // --- bottom → native: seek sync ---
  player.onSeek = (fraction) => {
    const audio = attachedAudio;
    if (!audio || !isFinite(audio.duration)) return;
    audio.currentTime = fraction * audio.duration;
  };

  // --- bottom → native: play/pause and track changes ---
  player.onPlayStateChange = () => scheduleReconcile();
  player.onCurrentPageTrackChange = () => {
    nativeAhead = false;
    scheduleReconcile();
  };

  // Attach listeners to the native audio element and mute it so only the
  // bottom player produces sound. Bandcamp may create the element lazily (on
  // first play), so we also watch for it appearing in the DOM.
  const attach = (audio: HTMLAudioElement) => {
    audio.muted = true;
    audio.addEventListener('play', onNativePlay);
    audio.addEventListener('pause', onNativePause);
    audio.addEventListener('ended', onNativeEnded, { capture: true });
    audio.addEventListener('seeked', onNativeSeeked);
    attachedAudio = audio;
    scheduleReconcile();
  };

  document.addEventListener('visibilitychange', onVisibilityChange);

  let audioWatcher: MutationObserver | null = null;
  const initialAudio = getNativeAudio();
  if (initialAudio) {
    attach(initialAudio);
  } else {
    audioWatcher = new MutationObserver(() => {
      const found = getNativeAudio();
      if (found) {
        audioWatcher?.disconnect();
        attach(found);
      }
    });
    audioWatcher.observe(document.body, { childList: true, subtree: true });
  }

  // --- native → bottom: track changes (native current_track class change) ---
  // Only while the bottom player is paused: while it plays, the native row
  // follows it, and a row the user clicks starts playing, which onNativePlay
  // picks up. Bandcamp changes classes in the table for other reasons too.
  const trackTableObserver = new MutationObserver(() => {
    if (dockTrack() || nativeAhead || rowSwitchTimer !== null) return;
    const row = currentRow();
    const pageUrl = row ? rowPageUrl(row) : null;
    if (pageUrl) player.cueTrackByPageUrl('currentpage', pageUrl);
  });

  const trackTable = document.querySelector<HTMLElement>(SEL_NATIVE_TRACK_TABLE);
  if (trackTable) {
    trackTableObserver.observe(trackTable, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  return () => {
    trackTableObserver.disconnect();
    audioWatcher?.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (reconcileTimer !== null) clearTimeout(reconcileTimer);
    endRowSwitch();
    if (attachedAudio) {
      attachedAudio.muted = false;
      attachedAudio.removeEventListener('play', onNativePlay);
      attachedAudio.removeEventListener('pause', onNativePause);
      attachedAudio.removeEventListener('ended', onNativeEnded, { capture: true });
      attachedAudio.removeEventListener('seeked', onNativeSeeked);
    }
  };
}
