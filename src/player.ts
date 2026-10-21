import type { PlaylistId, PlaylistTrack } from './types';
import { PLAYER_CSS } from './styles';
import { normalizeUrl } from './url';
import { isStreamFresh } from './cache';

// 'album' adds the album a single-track page belongs to (track.albumUrl).
type CartAddType = 'track' | 'release' | 'album';

const TEMPO_RANGES = [
  { label: '±6',   min: 0.94, max: 1.06 },
  { label: '±10',  min: 0.90, max: 1.10 },
  { label: '±16',  min: 0.84, max: 1.16 },
  { label: 'WIDE', min: 0.10, max: 2.00 },
] as const;

type StatusKind = 'loading' | 'error' | 'warn' | 'info';

// How many upcoming tracks get a fresh stream link and start buffering while
// the current one plays.
const PRELOAD_AHEAD = 4;
// How long preloading leaves a track alone after its refresh failed.
const PRELOAD_RETRY_AFTER_MS = 10 * 60 * 1000;

interface PlaylistState {
  label: string;
  tracks: PlaylistTrack[];
  lastIndex: number;
  statusMsg: string;
  statusKind: StatusKind;
  // Plays the releases last to first; tracks within a release keep their order.
  reversed: boolean;
  // Whether anything in the playlist was played; until then it sits on its
  // first track in play order, which moves when the order is reversed.
  started: boolean;
  // The playing track was removed and lastIndex already points at the track
  // that plays after it, so next() plays lastIndex itself.
  nextIsCurrent: boolean;
}

export class Player {
  readonly wrapper: HTMLElement;
  private bar: HTMLElement;
  private queueEl: HTMLElement;
  private headerEl: HTMLElement;

  private audio: HTMLAudioElement;
  private playlists = new Map<PlaylistId, PlaylistState>();
  private activeId: PlaylistId | null = null;

  private artworkEl!: HTMLImageElement;
  private titleEl!: HTMLAnchorElement;
  private subEl!: HTMLElement;
  private playPauseBtn!: HTMLButtonElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private seekBar!: HTMLInputElement;
  private currentTimeEl!: HTMLElement;
  private totalTimeEl!: HTMLElement;
  private tempoSlider!: HTMLInputElement;
  private tempoResetBtn!: HTMLButtonElement;
  private tempoRangeBtn!: HTMLButtonElement;
  private tempoMTBtn!: HTMLButtonElement;
  private playbackRate = 1;
  private preservesPitch = true;
  private tempoRangeIndex = 1;
  private showDiscographyButton = true;
  // Saved reverse-order choice per playlist, applied when a playlist is set.
  private reversedPlaylists: Partial<Record<PlaylistId, boolean>> = {};
  private statusEl!: HTMLElement;
  private queueToggleBtn!: HTMLButtonElement;
  private reloadBtn!: HTMLButtonElement;
  private cacheBtn!: HTMLButtonElement;

  private queueVisible = false;
  private playerVisible = true;
  // Playlists that can't be played (yet), shown as greyed-out tabs that explain
  // why, or as clickable tabs when they load on demand.
  private unavailablePlaylists = new Map<PlaylistId, { label: string; reason: string; kind: StatusKind; onLoad?: () => void }>();
  private collapseBtn!: HTMLButtonElement;
  private seeking = false;
  private switchingPlaylist = false;
  // Bumped by every play, pause and track change, so a play that is still
  // waiting for a fresh stream link can tell it has been superseded.
  private playRequestId = 0;
  private playPending = false;
  private playStarts = 0;
  // The track whose stream is in the audio element. It can differ from the
  // current track, e.g. after the playing release is removed from the cart.
  private sourceTrack: PlaylistTrack | null = null;
  private streamRetriedFor: PlaylistTrack | null = null;
  // Upcoming tracks buffering in standby audio elements, keyed by stream link,
  // so skipping ahead swaps one in instead of starting a cold load.
  private preloaded = new Map<string, HTMLAudioElement>();
  // Bumped by every preload run and playlist switch, so an older run stops
  // once superseded.
  private preloadRunId = 0;
  // Tracks whose preload refresh still left a stale link (e.g. the release page
  // is gone), mapped to when preloading may try again. Retrying on every
  // 'playing' event would hammer Bandcamp; playing the track still refreshes it.
  private preloadRetryAt = new WeakMap<PlaylistTrack, number>();

  private announcer!: HTMLElement;
  private cartUrls = new Set<string>();
  private cartActionsEl!: HTMLElement;

  onCartAdd?: (track: PlaylistTrack, addType: CartAddType) => Promise<boolean | void>;
  onCartRemove?: (track: PlaylistTrack, cartItemUrl: string) => Promise<void>;
  onCheckoutSelected?: (selectedRawUrls: string[]) => Promise<void>;
  onPlaybackStart?: () => void;
  onPlayStateChange?: (playing: boolean) => void;
  onCurrentPageTrackChange?: (pageUrl: string) => void;
  onTrackChange?: (id: PlaylistId, index: number) => void;
  onSeek?: (fraction: number) => void;
  onDiscographyButtonVisibilityChange?: (show: boolean) => void;
  onReloadPlaylist?: () => Promise<void>;
  onShowCache?: () => Promise<void> | void;
  // Updates the track's streamUrl in place; `force` skips any cached copy and
  // `bulk` queues the fetch behind ones the user is waiting on.
  onRefreshStream?: (track: PlaylistTrack, force: boolean, bulk?: boolean) => Promise<void>;

  constructor(initialPlaylist: PlaylistTrack[]) {
    this.audio = this.createAudio();
    this.audio.preservesPitch = this.preservesPitch;

    injectStyles();

    this.wrapper = document.createElement('div');
    this.wrapper.id = 'bcp-wrapper';

    this.collapseBtn = btn('Hide player ▼', '');
    this.collapseBtn.id = 'bcp-collapse-btn';
    this.collapseBtn.title = 'Hide player';
    this.collapseBtn.addEventListener('click', () => this.togglePlayer());

    this.queueEl = this.buildQueueEl();
    this.headerEl = this.buildHeaderEl();
    this.bar = this.buildBarEl();

    this.wrapper.appendChild(this.collapseBtn);
    this.wrapper.appendChild(this.queueEl);
    this.wrapper.appendChild(this.headerEl);
    this.wrapper.appendChild(this.bar);

    this.announcer = el('div', 'bcp-visually-hidden');
    this.announcer.setAttribute('role', 'status');
    this.wrapper.appendChild(this.announcer);

    new ResizeObserver(() => {
      document.body.style.paddingBottom = this.wrapper.offsetHeight + 'px';
    }).observe(this.wrapper);

    this.setupMediaSession();

    chrome.storage.local.get(['tempoRangeIndex', 'preservesPitch', 'showDiscographyButton', 'reversedPlaylists'], (result) => {
      if (typeof result['tempoRangeIndex'] === 'number') {
        this.tempoRangeIndex = result['tempoRangeIndex'] as number;
      }
      if (typeof result['preservesPitch'] === 'boolean') {
        this.preservesPitch = result['preservesPitch'] as boolean;
        this.audio.preservesPitch = this.preservesPitch;
      }
      if (typeof result['showDiscographyButton'] === 'boolean') {
        this.showDiscographyButton = result['showDiscographyButton'] as boolean;
      }
      const reversed = result['reversedPlaylists'];
      if (reversed && typeof reversed === 'object') {
        this.reversedPlaylists = reversed as Partial<Record<PlaylistId, boolean>>;
        for (const [id, state] of this.playlists) {
          this.applyReversed(id, state, !!this.reversedPlaylists[id]);
        }
        this.updateHeader();
        this.updateQueueEl();
        this.updateNavButtons();
      }
      this.updateTempoUI();
      if (!this.showDiscographyButton) {
        this.onDiscographyButtonVisibilityChange?.(false);
      }
    });

    if (initialPlaylist.length > 0) {
      this.setPlaylist('cart', 'Cart', initialPlaylist);
    } else {
      this.updateHeader();
    }
  }

  // --- Public API -----------------------------------------------------------

  get discographyButtonEnabled(): boolean {
    return this.showDiscographyButton;
  }

  // Shows a greyed-out tab for a playlist that is loading, failed to load or
  // is empty; hovering or clicking it shows `reason`. Setting or adding tracks
  // to the playlist replaces it with the normal tab.
  setPlaylistUnavailable(id: PlaylistId, label: string, reason: string, kind: StatusKind = 'info') {
    this.unavailablePlaylists.set(id, { label, reason, kind });
    this.updateHeader();
  }

  // Shows a clickable tab for a playlist that only loads when asked; `onLoad`
  // runs on click and is expected to set or grey out the playlist.
  setPlaylistOnDemand(id: PlaylistId, label: string, hint: string, onLoad: () => void) {
    this.unavailablePlaylists.set(id, { label, reason: hint, kind: 'info', onLoad });
    this.updateHeader();
  }

  setPlaylist(id: PlaylistId, label: string, tracks: PlaylistTrack[]) {
    const previous = this.playlists.get(id);
    const isNew = !previous;
    // A reload replaces the playlist mid-playback; it still counts as played.
    const state: PlaylistState = {
      label, tracks, lastIndex: 0, statusMsg: '', statusKind: 'info',
      reversed: !!this.reversedPlaylists[id], started: previous?.started ?? false, nextIsCurrent: false,
    };
    state.lastIndex = firstPlayable(state);
    this.playlists.set(id, state);
    if (tracks.length > 0) this.unavailablePlaylists.delete(id);
    this.updateHeader();
    if (isNew && this.playlists.size === 1) {
      this.selectPlaylist(id);
    }
  }

  selectPlaylist(id: PlaylistId, silent = false) {
    const state = this.playlists.get(id);
    if (!state) return;
    this.audio.pause();
    // loadTrack() calls audio.load() when the stream URL changes, which removes
    // pending tasks from the media element's event queue — including the 'pause'
    // event dispatched above. Reflect the paused state explicitly so the glyph
    // and onPlayStateChange callbacks aren't silently dropped.
    // Skip when silent: silent selects are native-driven (onNativePlay → jumpTo)
    // and pushing paused state back would pause the native audio that just started.
    if (!silent) {
      this.switchingPlaylist = true;
      this.reflectPlaybackState(false);
      this.switchingPlaylist = false;
      // Reset playback position to the beginning. audio.load() does this when the
      // stream URL changes, but not when the same track is reloaded — explicit
      // reset covers both cases.
      this.audio.currentTime = 0;
      this.currentTimeEl.textContent = '0:00';
      this.seekBar.value = '0';
    }
    if (this.activeId !== id) this.clearPreloaded();
    this.activeId = id;
    this.updateHeader();
    this.updateQueueEl();
    // Always load silently: tab switches must not fire onCurrentPageTrackChange,
    // which clicks the native row and triggers a native 'play' event that echoes
    // back through onNativePlay and restarts the bottom player. jumpTo() calls
    // loadTrack() separately with the correct silent value when it needs to play.
    this.loadTrack(state.lastIndex, true);
    if (state.statusMsg) {
      this.setStatus(state.statusMsg, state.statusKind);
    }
  }

  jumpTo(id: PlaylistId, index: number, silent = false) {
    if (this.activeId !== id) {
      this.selectPlaylist(id, silent);
    }
    this.loadTrack(index, silent);
    void this.startPlayback({});
  }

  showToast(msg: string, kind: StatusKind = 'info') {
    const toast = el('div', `bcp-toast bcp-toast-${kind}`);
    toast.setAttribute('aria-hidden', 'true');
    toast.textContent = msg;
    // Screen readers announce changes to an existing live region, not a newly
    // added element, so the message also goes to the player's persistent one.
    this.announcer.textContent = '';
    setTimeout(() => { this.announcer.textContent = msg; }, 50);
    document.body.appendChild(toast);
    // Force reflow so the CSS transition has a starting state to animate from.
    toast.getBoundingClientRect();
    toast.classList.add('bcp-toast-visible');
    setTimeout(() => {
      toast.classList.remove('bcp-toast-visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, 3000);
  }

  setStatus(msg: string, kind: StatusKind = 'info') {
    this.statusEl.textContent = msg;
    this.statusEl.className = `bcp-status bcp-status-${kind}`;
    const state = this.active();
    if (state) {
      state.statusMsg = msg;
      state.statusKind = kind;
    }
  }

  setPlaylistStatus(id: PlaylistId, msg: string, kind: StatusKind = 'info') {
    const state = this.playlists.get(id);
    if (!state) return;
    state.statusMsg = msg;
    state.statusKind = kind;
    if (id === this.activeId) {
      this.setStatus(msg, kind);
    }
  }

  setCartUrls(urls: Set<string>) {
    this.cartUrls = urls;
    this.updateQueueEl();
    const state = this.active();
    if (state) {
      const track = state.tracks[state.lastIndex];
      if (track) this.updateCartActions(track);
    }
  }

  removeCartUrl(url: string) {
    const normalized = normalizeUrl(url);
    if (!this.cartUrls.has(normalized)) return;
    const updated = new Set(this.cartUrls);
    updated.delete(normalized);
    this.setCartUrls(updated);
  }

  addCartUrl(url: string) {
    const normalized = normalizeUrl(url);
    if (this.cartUrls.has(normalized)) return;
    const updated = new Set(this.cartUrls);
    updated.add(normalized);
    this.setCartUrls(updated);
  }

  // Returns the starting index of the newly added tracks, or null if nothing was added.
  addTracksToPlaylist(id: PlaylistId, tracks: PlaylistTrack[]): number | null {
    let state = this.playlists.get(id);
    if (!state) {
      // Initialise the playlist on first add (e.g. cart was empty at page load).
      if (tracks.length === 0) return null;
      this.setPlaylist(id, id === 'cart' ? 'Cart' : 'Label discography', []);
      state = this.playlists.get(id)!;
    }
    const existingPages = new Set(state.tracks.map((t) => t.pageUrl));
    const toAdd = tracks.filter((t) => !existingPages.has(t.pageUrl));
    if (toAdd.length === 0) return null;
    const startIndex = state.tracks.length;
    state.tracks.push(...toAdd);
    this.unavailablePlaylists.delete(id);
    // The reverse button depends on how many releases there are.
    this.updateHeader();
    if (this.activeId === id) {
      // Selecting an empty playlist leaves the bar blank, so load its first
      // track now, unless a removed track is still playing.
      if (startIndex === 0 && this.audio.paused) this.loadTrack(firstPlayable(state), true);
      else this.updateQueueEl();
    }
    return startIndex;
  }

  // The track a playlist starts from: its first playable one in play order.
  firstTrackIndex(id: PlaylistId): number | undefined {
    const state = this.playlists.get(id);
    return state && state.tracks.length > 0 ? firstPlayable(state) : undefined;
  }

  getPlaylistTracks(id: PlaylistId): PlaylistTrack[] {
    return this.playlists.get(id)?.tracks ?? [];
  }

  pause() {
    this.cancelPendingPlay();
    this.audio.pause();
  }

  play() {
    void this.startPlayback({ track: this.sourceTrack ?? undefined });
  }

  getActiveTrack(id: PlaylistId): PlaylistTrack | null {
    const state = this.playlists.get(id);
    if (!state) return null;
    return state.tracks[state.lastIndex] ?? null;
  }

  seekToFraction(fraction: number) {
    if (!isFinite(this.audio.duration)) return;
    this.audio.currentTime = fraction * this.audio.duration;
    this.seekBar.value = String(fraction * 100);
  }

  cueTrackByPageUrl(id: PlaylistId, pageUrl: string) {
    const state = this.playlists.get(id);
    if (!state) return;
    const idx = state.tracks.findIndex((t) => normalizeUrl(t.pageUrl) === normalizeUrl(pageUrl));
    if (idx === -1) return;
    if (id === this.activeId) {
      this.loadTrack(idx, true);
    } else {
      state.lastIndex = idx;
    }
  }

  /** Stop audio, remove injected UI, and reset the body padding. */
  destroy() {
    this.audio.pause();
    this.audio.src = '';
    this.clearPreloaded();
    this.wrapper.remove();
    document.body.style.paddingBottom = '';
  }

  removeTracksByReleaseUrl(id: PlaylistId, releaseUrl: string) {
    const state = this.playlists.get(id);
    if (!state) return;
    const normalized = normalizeUrl(releaseUrl);
    this.removeTracks(state, (t) => normalizeUrl(t.releaseUrl) === normalized);
    if (this.activeId === id) {
      // Don't touch the audio — let the current stream finish naturally.
      this.updateHeader();
      this.updateQueueEl();
      this.updateNavButtons();
    }
  }

  removeTrackByPageUrl(id: PlaylistId, pageUrl: string) {
    const state = this.playlists.get(id);
    if (!state) return;
    const normalized = normalizeUrl(pageUrl);
    const idx = state.tracks.findIndex((t) => normalizeUrl(t.pageUrl) === normalized);
    if (idx === -1) return;
    this.removeTracks(state, (t) => t === state.tracks[idx]);
    if (this.activeId === id) {
      this.updateHeader();
      this.updateQueueEl();
      this.updateNavButtons();
    }
  }

  // --- Private helpers -------------------------------------------------------

  // Removes the matching tracks and moves lastIndex so next() continues where
  // it would have: when the current track goes, lastIndex moves to the first
  // survivor after it in play order, which next() then plays.
  private removeTracks(state: PlaylistState, removed: (track: PlaylistTrack) => boolean) {
    const current = state.tracks[state.lastIndex];
    let anchor = current;
    if (current && removed(current)) {
      const order = playOrder(state);
      const position = order.indexOf(state.lastIndex);
      const following = order.slice(position + 1).map((i) => state.tracks[i]!).find((t) => !removed(t));
      if (following) {
        anchor = following;
        state.nextIsCurrent = true;
      } else {
        const kept = state.tracks.filter((t) => !removed(t));
        const keptOrder = playOrder({ ...state, tracks: kept });
        anchor = kept[keptOrder[keptOrder.length - 1]!];
        state.nextIsCurrent = false;
      }
    }
    state.tracks = state.tracks.filter((t) => !removed(t));
    state.lastIndex = Math.max(0, anchor ? state.tracks.indexOf(anchor) : 0);
  }

  // Sets the playlist's order. One that has not played yet moves to the first
  // track of its new order, so it starts from the right end.
  private applyReversed(id: PlaylistId, state: PlaylistState, reversed: boolean) {
    if (state.reversed === reversed) return;
    state.reversed = reversed;
    if (state.started || state.tracks.length === 0) return;
    const first = firstPlayable(state);
    if (id === this.activeId) {
      // Never pull the bar away from a track that is playing or about to.
      if (!this.audio.paused || this.playPending) return;
      this.loadTrack(first, true);
    }
    else state.lastIndex = first;
  }

  // Returns the cart-item key for a track: pageUrl for single-track purchases
  // (where Bandcamp stores the track page URL in the sidecart), albumUrl when a
  // track page's album was added, releaseUrl for full-release purchases. This is
  // the URL used as the key in cartUrls and is the unit of selection for partial
  // checkout.
  private cartItemKeyFor(track: PlaylistTrack): string {
    if (this.cartUrls.has(normalizeUrl(track.pageUrl))) return track.pageUrl;
    if (track.albumUrl && this.cartUrls.has(normalizeUrl(track.albumUrl))) return track.albumUrl;
    return track.releaseUrl;
  }

  // A track is "in cart" if its cart-item key appears in cartUrls.
  private isInCart(track: PlaylistTrack): boolean {
    return this.cartUrls.has(normalizeUrl(this.cartItemKeyFor(track)));
  }

  private active(): PlaylistState | null {
    if (this.activeId === null) return null;
    return this.playlists.get(this.activeId) ?? null;
  }

  private buildHeaderEl(): HTMLElement {
    const header = document.createElement('div');
    header.id = 'bcp-header';
    return header;
  }

  private updateHeader() {
    this.headerEl.innerHTML = '';

    const tabs = document.createElement('div');
    tabs.id = 'bcp-tabs';

    const label = document.createElement('span');
    label.textContent = 'Playlist type:';
    tabs.appendChild(label);

    const ids: PlaylistId[] = ['currentpage', 'discography', 'cart'];

    for (const id of ids) {
      const state = this.playlists.get(id);
      const unavailable = this.unavailablePlaylists.get(id);
      if (!state && !unavailable) continue;
      const tab = document.createElement('button');
      tab.className = 'bcp-tab' + (id === this.activeId ? ' bcp-tab-active' : '');
      // An emptied playlist (e.g. every cart item removed) shows its reason too.
      if (state && !(state.tracks.length === 0 && unavailable)) {
        tab.textContent = state.label;
        tab.addEventListener('click', () => this.selectPlaylist(id));
      } else if (unavailable?.onLoad) {
        tab.textContent = unavailable.label;
        tab.title = unavailable.reason;
        tab.addEventListener('click', unavailable.onLoad);
      } else if (unavailable) {
        // Not `disabled`: disabled buttons ignore clicks, and the click is how
        // the reason gets shown on touch devices.
        tab.textContent = unavailable.label;
        tab.title = unavailable.reason;
        tab.classList.add('bcp-tab-unavailable', `bcp-tab-${unavailable.kind}`);
        tab.setAttribute('aria-disabled', 'true');
        tab.addEventListener('click', () => this.showToast(unavailable.reason, unavailable.kind));
      }
      tabs.appendChild(tab);
    }

    const state = this.active();
    if (state && state.tracks.length > 0) {
      const reverseBtn = btn('⇅ Reverse', 'bcp-tab bcp-reverse-btn');
      reverseBtn.setAttribute('aria-pressed', String(state.reversed));
      if (state.reversed) reverseBtn.classList.add('bcp-tab-active');
      if (releaseBlocks(state.tracks).length > 1) {
        reverseBtn.title = 'Play releases last to first (tracks within a release keep their order)';
        reverseBtn.addEventListener('click', () => this.toggleReversed());
      } else {
        reverseBtn.classList.add('bcp-tab-unavailable');
        reverseBtn.setAttribute('aria-disabled', 'true');
        reverseBtn.title = 'Only one release';
      }
      tabs.appendChild(reverseBtn);
    }

    this.headerEl.appendChild(tabs);
  }

  private buildBarEl(): HTMLElement {
    const bar = document.createElement('div');
    bar.id = 'bcp-bar';

    this.artworkEl = el('img') as HTMLImageElement;
    this.artworkEl.id = 'bcp-artwork';
    this.artworkEl.alt = '';

    const trackInfo = el('div', 'bcp-track-info');
    this.titleEl = document.createElement('a');
    this.titleEl.className = 'bcp-track-title';
    this.titleEl.textContent = 'No tracks loaded';
    this.titleEl.target = '_blank';
    this.titleEl.rel = 'noopener noreferrer';
    this.subEl = el('div', 'bcp-track-sub');
    trackInfo.append(this.titleEl, this.subEl);

    this.prevBtn = btn('⏮', 'bcp-btn');
    this.prevBtn.title = 'Previous';
    this.prevBtn.addEventListener('click', () => this.prev());

    this.playPauseBtn = btn('▶', 'bcp-btn bcp-btn-play');
    this.playPauseBtn.title = 'Play / Pause';
    this.playPauseBtn.addEventListener('click', () => this.togglePlay());

    this.nextBtn = btn('⏭', 'bcp-btn');
    this.nextBtn.title = 'Next';
    this.nextBtn.addEventListener('click', () => this.next());

    const controls = el('div', 'bcp-controls');
    controls.append(this.prevBtn, this.playPauseBtn, this.nextBtn);

    this.currentTimeEl = el('div', 'bcp-time bcp-time-current');
    this.currentTimeEl.textContent = '0:00';
    this.totalTimeEl = el('div', 'bcp-time bcp-time-total');
    this.totalTimeEl.textContent = '0:00';

    this.seekBar = el('input', 'bcp-range bcp-seek') as HTMLInputElement;
    this.seekBar.type = 'range';
    this.seekBar.min = '0';
    this.seekBar.max = '100';
    this.seekBar.value = '0';
    this.seekBar.addEventListener('mousedown', () => (this.seeking = true));
    this.seekBar.addEventListener('mouseup', () => {
      this.seeking = false;
      const fraction = parseFloat(this.seekBar.value) / 100;
      this.audio.currentTime = fraction * this.audio.duration;
      if (this.activeId === 'currentpage') {
        this.onSeek?.(fraction);
      }
    });

    const seekArea = el('div', 'bcp-seek-area');
    seekArea.append(this.currentTimeEl, this.seekBar, this.totalTimeEl);

    this.tempoSlider = el('input', 'bcp-range bcp-tempo') as HTMLInputElement;
    this.tempoSlider.type = 'range';
    this.tempoSlider.step = '0.001';
    this.tempoSlider.addEventListener('input', () => {
      this.playbackRate = parseFloat(this.tempoSlider.value);
      this.audio.playbackRate = this.playbackRate;
      this.updateTempoUI();
    });

    this.tempoResetBtn = btn('+0.0%', 'bcp-btn bcp-tempo-btn bcp-tempo-reset-btn');
    this.tempoResetBtn.title = 'Reset tempo';
    this.tempoResetBtn.addEventListener('click', () => {
      this.playbackRate = 1;
      this.audio.playbackRate = 1;
      this.updateTempoUI();
    });

    this.tempoRangeBtn = btn('(±10)', 'bcp-btn bcp-tempo-btn bcp-tempo-range-btn');
    this.tempoRangeBtn.title = 'Cycle tempo range';
    this.tempoRangeBtn.addEventListener('click', () => {
      this.tempoRangeIndex = (this.tempoRangeIndex + 1) % TEMPO_RANGES.length;
      const range = TEMPO_RANGES[this.tempoRangeIndex]!;
      this.playbackRate = Math.max(range.min, Math.min(range.max, this.playbackRate));
      this.audio.playbackRate = this.playbackRate;
      chrome.storage.local.set({ tempoRangeIndex: this.tempoRangeIndex });
      this.updateTempoUI();
    });

    this.tempoMTBtn = btn('MT', 'bcp-btn bcp-tempo-btn');
    this.tempoMTBtn.title = 'Master Tempo (pitch lock)';
    this.tempoMTBtn.addEventListener('click', () => {
      this.preservesPitch = !this.preservesPitch;
      this.audio.preservesPitch = this.preservesPitch;
      chrome.storage.local.set({ preservesPitch: this.preservesPitch });
      this.updateTempoUI();
    });

    const tempoLabel = el('span', 'bcp-tempo-label');
    tempoLabel.textContent = 'Tempo adjust';
    const tempoArea = el('div', 'bcp-tempo-area');
    tempoArea.append(tempoLabel, this.tempoSlider, this.tempoResetBtn, this.tempoRangeBtn, this.tempoMTBtn);

    this.cartActionsEl = el('div', 'bcp-cart-actions');

    this.queueToggleBtn = btn('☰', 'bcp-btn');
    this.queueToggleBtn.title = 'Toggle queue';
    this.queueToggleBtn.addEventListener('click', () => this.toggleQueue());

    this.cacheBtn = btn('🗄', 'bcp-btn');
    this.cacheBtn.title = 'Show track cache contents';
    this.cacheBtn.addEventListener('click', () => this.onShowCache?.());

    this.reloadBtn = btn('⟳', 'bcp-btn');
    this.reloadBtn.title = 'Reload playlist information (clears track cache)';
    this.reloadBtn.addEventListener('click', async () => {
      this.reloadBtn.disabled = true;
      try { await this.onReloadPlaylist?.(); }
      finally { this.reloadBtn.disabled = false; }
    });

    this.statusEl = el('div', 'bcp-status');

    bar.append(
      this.artworkEl,
      trackInfo,
      this.cartActionsEl,
      controls,
      seekArea,
      tempoArea,
      this.queueToggleBtn,
      this.statusEl,
      this.cacheBtn,
      this.reloadBtn
    );

    return bar;
  }

  private buildQueueEl(): HTMLElement {
    const queue = document.createElement('div');
    queue.id = 'bcp-queue';
    return queue;
  }

  private updateQueueEl() {
    const state = this.active();
    this.queueEl.innerHTML = '';
    if (!state) return;

    playOrder(state).forEach((i, position) => {
      const track = state.tracks[i]!;
      const item = el('div', 'bcp-queue-item');
      if (i === state.lastIndex) item.classList.add('bcp-active');
      if (track.unplayable) item.classList.add('bcp-unplayable');

      const num = el('div', 'bcp-queue-num');
      num.textContent = String(position + 1);

      const text = el('div', 'bcp-queue-text');
      const title = el('div', 'bcp-queue-title');
      title.textContent = track.trackTitle || '(untitled)';
      const sub = el('div', 'bcp-queue-sub');
      sub.textContent = [track.artist, track.albumTitle].filter(Boolean).join(' — ');
      text.append(title, sub);

      item.append(num, text);

      if (this.isInCart(track)) {
        const marker = el('div', 'bcp-queue-cart-marker');
        marker.textContent = '✓';
        marker.title = 'In cart';
        item.append(marker);
      }

      if (track.unplayable) {
        const hint = el('div', 'bcp-no-stream');
        hint.textContent = '⚠ no stream';
        item.append(hint);
      } else {
        item.addEventListener('click', () => {
          this.loadTrack(i);
          void this.startPlayback({});
        });
      }

      this.queueEl.appendChild(item);
    });
  }

  private loadTrack(index: number, silent = false) {
    const state = this.active();
    if (!state) return;
    this.cancelPendingPlay();

    state.lastIndex = index;
    state.nextIsCurrent = false;
    const track = state.tracks[index];
    if (!track) return;

    this.onTrackChange?.(this.activeId!, index);

    // Only reload when the stream URL actually changes. Keeping the same src
    // preserves the current playback position across pause/resume cycles (e.g.
    // when the native Bandcamp player triggers a play event for a track the
    // bottom player already has loaded mid-way through). The loaded track also
    // counts as unchanged when a refresh gave it a new link, e.g. while
    // preloading another track of its release, so it isn't restarted.
    const isLoaded = track === this.sourceTrack || track.streamUrl === this.audio.src;
    const needsReload = !track.streamUrl || track.unplayable || !isLoaded;

    this.artworkEl.src = track.artworkUrl || '';
    this.titleEl.textContent = track.trackTitle || '(untitled)';
    this.titleEl.href = track.pageUrl;
    this.subEl.innerHTML = '';
    if (track.artist) this.subEl.appendChild(document.createTextNode(track.albumTitle ? `${track.artist} — ` : track.artist));
    if (track.albumTitle) {
      const albumLink = document.createElement('a');
      albumLink.className = 'bcp-track-album-link';
      albumLink.href = track.releaseUrl;
      albumLink.target = '_blank';
      albumLink.rel = 'noopener noreferrer';
      albumLink.textContent = track.albumTitle;
      this.subEl.appendChild(albumLink);
    }
    if (needsReload) {
      this.currentTimeEl.textContent = '0:00';
      this.seekBar.value = '0';
    }
    this.totalTimeEl.textContent = fmtTime(track.durationSec);
    this.updateNavButtons();
    this.updateQueueEl();
    this.updateCartActions(track);
    this.updateMediaSessionMetadata(track);

    if (!silent && this.activeId === 'currentpage') {
      this.onCurrentPageTrackChange?.(track.pageUrl);
    }

    if (track.unplayable || !track.streamUrl) {
      this.setPlayButton('play');
      this.playPauseBtn.disabled = true;
      return;
    }

    this.playPauseBtn.disabled = false;
    if (!needsReload) {
      this.sourceTrack = track;
    } else if (!this.onRefreshStream || isStreamFresh(track)) {
      this.setSource(track);
    } else {
      // startPlayback fetches a fresh link first; loading this one could only fail.
      this.audio.removeAttribute('src');
      this.audio.load();
      this.sourceTrack = null;
    }
  }

  private currentTrack(): PlaylistTrack | null {
    const state = this.active();
    return state?.tracks[state.lastIndex] ?? null;
  }

  private setSource(track: PlaylistTrack, startAt = 0) {
    const url = track.streamUrl ?? '';
    const standby = this.preloaded.get(url);
    this.preloaded.delete(url);
    if (standby && !standby.error) {
      const previous = this.audio;
      this.audio = standby;
      previous.pause();
      unloadAudio(previous);
      // Its 'loadedmetadata' fired while it was on standby, so it was ignored.
      if (isFinite(standby.duration)) this.totalTimeEl.textContent = fmtTime(standby.duration);
    } else {
      if (standby) unloadAudio(standby);
      this.audio.src = url;
      this.audio.load();
    }
    this.audio.currentTime = startAt;
    this.audio.playbackRate = this.playbackRate;
    this.audio.preservesPitch = this.preservesPitch;
    this.sourceTrack = track;
  }

  private cancelPendingPlay() {
    this.playRequestId++;
    if (!this.playPending) return;
    this.playPending = false;
    this.setPlayButton('play');
  }

  // Plays `track` (the current track by default), first fetching a fresh
  // stream link when the one we have may have expired. `skip` is the direction
  // to move in when the refresh shows the track can no longer be streamed.
  private async startPlayback(options: {
    track?: PlaylistTrack;
    forceRefresh?: boolean;
    skip?: 1 | -1;
  }): Promise<void> {
    const track = options.track ?? this.currentTrack();
    if (!track?.streamUrl || track.unplayable) return;
    const state = this.active();
    if (state) state.started = true;
    const isLoaded = track === this.sourceTrack;
    // A newer link for the playing track would only interrupt it.
    if (isLoaded && !this.audio.paused && !options.forceRefresh) return;
    const requestId = ++this.playRequestId;
    let refreshed = false;

    if (this.onRefreshStream && (options.forceRefresh || !isStreamFresh(track))) {
      this.playPending = true;
      this.setPlayButton('loading');
      try {
        await this.onRefreshStream(track, !!options.forceRefresh);
        refreshed = true;
      } catch (err) {
        console.warn('[bcp] Could not refresh stream link', err);
      }
      if (requestId !== this.playRequestId) return;
      this.playPending = false;
      if (track.unplayable || !track.streamUrl) {
        this.showUnplayable(track, options.skip);
        return;
      }
      this.updateQueueEl();
      this.updateNavButtons();
    }

    if (refreshed || !isLoaded) {
      this.setSource(track, isLoaded ? this.audio.currentTime : 0);
    }
    this.audio.play().catch((err: unknown) => {
      console.warn(err);
      if (this.audio.paused) this.setPlayButton('play');
    });
  }

  private showUnplayable(track: PlaylistTrack, skip?: 1 | -1) {
    this.setPlayButton('play');
    const state = this.active();
    const index = state ? state.tracks.indexOf(track) : -1;
    if (index === -1) {
      // The track was removed from the playlist while loaded; carry on from the current one.
      if (skip === 1) this.next();
      else if (skip === -1) this.prev();
      return;
    }
    this.loadTrack(index, true);
    if (!skip) return;
    const nextIndex = this.stepPlayable(index, skip);
    if (nextIndex === -1) return;
    this.loadTrack(nextIndex);
    void this.startPlayback({ skip });
  }

  get currentPlaylistId(): PlaylistId | null {
    return this.activeId;
  }

  get isPlaylistSwitching(): boolean {
    return this.switchingPlaylist;
  }

  get isPlaying(): boolean {
    return !this.audio.paused;
  }

  // Counts every start of playback, so a caller can tell whether the user
  // started something while it was waiting.
  get playStartCount(): number {
    return this.playStarts;
  }

  // Re-reads which tracks are playable after their details were updated in place.
  refreshTrackAvailability() {
    this.updateQueueEl();
    this.updateNavButtons();
    const track = this.currentTrack();
    if (track && this.audio.paused && !this.playPending) {
      this.playPauseBtn.disabled = track.unplayable || !track.streamUrl;
    }
  }

  private setPlayButton(state: 'play' | 'pause' | 'loading') {
    if (state === 'loading') {
      const spinner = document.createElement('span');
      spinner.className = 'bcp-spinner';
      this.playPauseBtn.replaceChildren(spinner);
      this.playPauseBtn.setAttribute('aria-label', 'Loading');
    } else {
      this.playPauseBtn.textContent = state === 'play' ? '▶' : '⏸';
      this.playPauseBtn.setAttribute('aria-label', state === 'play' ? 'Play' : 'Pause');
    }
  }

  private reflectPlaybackState(playing: boolean) {
    this.setPlayButton(playing ? 'pause' : 'play');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
    this.onPlayStateChange?.(playing);
  }

  // Every element is bound once; only the one currently in `this.audio`
  // reacts, so standby elements buffering upcoming tracks stay silent.
  private createAudio(): HTMLAudioElement {
    const audio = new Audio();
    const on = (type: keyof HTMLMediaElementEventMap, listener: () => void) => {
      audio.addEventListener(type, () => {
        if (audio === this.audio) listener();
      });
    };
    this.bindAudioEvents(on);
    return audio;
  }

  // Fetches fresh links for the next few tracks and starts buffering them, so
  // skipping ahead waits on neither a release-page fetch nor a cold stream.
  private async preloadUpcoming() {
    const runId = ++this.preloadRunId;
    const upcoming = this.upcomingTracks();
    let refreshed = false;
    for (const track of upcoming) {
      if (!this.onRefreshStream || isStreamFresh(track)) continue;
      if (Date.now() < (this.preloadRetryAt.get(track) ?? 0)) continue;
      try {
        await this.onRefreshStream(track, false, true);
        refreshed = true;
      } catch (err) {
        console.warn('[bcp] Could not preload stream link', err);
      }
      if (!isStreamFresh(track)) this.preloadRetryAt.set(track, Date.now() + PRELOAD_RETRY_AFTER_MS);
      if (runId !== this.preloadRunId) return;
    }
    if (refreshed) {
      this.updateQueueEl();
      this.updateNavButtons();
    }

    const wanted = upcoming
      .filter((t) => !t.unplayable && t.streamUrl && (!this.onRefreshStream || isStreamFresh(t)))
      .map((t) => t.streamUrl!);
    for (const [url, standby] of this.preloaded) {
      if (wanted.includes(url)) continue;
      unloadAudio(standby);
      this.preloaded.delete(url);
    }
    for (const url of wanted) {
      if (this.preloaded.has(url) || url === this.audio.src) continue;
      const standby = this.createAudio();
      standby.preload = 'auto';
      standby.src = url;
      this.preloaded.set(url, standby);
    }
  }

  private clearPreloaded() {
    this.preloadRunId++;
    for (const standby of this.preloaded.values()) unloadAudio(standby);
    this.preloaded.clear();
  }

  private upcomingTracks(): PlaylistTrack[] {
    const state = this.active();
    if (!state) return [];
    const upcoming: PlaylistTrack[] = [];
    let index = this.nextIndex(state);
    while (upcoming.length < PRELOAD_AHEAD) {
      if (index === -1) break;
      upcoming.push(state.tracks[index]!);
      index = this.stepPlayable(index, 1);
    }
    return upcoming;
  }

  private bindAudioEvents(on: (type: keyof HTMLMediaElementEventMap, listener: () => void) => void) {
    on('play', () => {
      this.playStarts++;
      this.reflectPlaybackState(true);
      this.onPlaybackStart?.();
    });

    on('pause', () => {
      this.reflectPlaybackState(false);
    });

    on('timeupdate', () => {
      if (this.seeking || !isFinite(this.audio.duration)) return;
      this.currentTimeEl.textContent = fmtTime(this.audio.currentTime);
      this.seekBar.value = String((this.audio.currentTime / this.audio.duration) * 100);
    });

    on('loadedmetadata', () => {
      this.totalTimeEl.textContent = fmtTime(this.audio.duration);
    });

    on('ended', () => {
      this.next();
    });

    on('playing', () => {
      this.streamRetriedFor = null;
      void this.preloadUpcoming();
    });

    on('error', () => {
      if (!this.audio.getAttribute('src')) return;
      console.warn('[bcp] Audio error for track', this.active()?.lastIndex, this.audio.error);
      // The link may have expired mid-session; fetch a fresh one once before
      // skipping the track.
      const track = this.sourceTrack;
      if (track && this.onRefreshStream && this.streamRetriedFor !== track) {
        this.streamRetriedFor = track;
        void this.startPlayback({ track, forceRefresh: true, skip: 1 });
        return;
      }
      this.next();
    });
  }

  private setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => this.play());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) this.audio.currentTime = details.seekTime;
    });
  }

  private updateMediaSessionMetadata(track: PlaylistTrack) {
    if (!('mediaSession' in navigator)) return;
    const artwork = track.artworkUrl
      ? [{ src: track.artworkUrl }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.trackTitle || '(untitled)',
      artist: track.artist || '',
      album: track.albumTitle || '',
      artwork,
    });
  }

  private togglePlay() {
    if (this.playPending) {
      this.cancelPendingPlay();
    } else if (this.audio.paused) {
      this.play();
    } else {
      this.audio.pause();
    }
  }

  private next() {
    const state = this.active();
    if (!state) return;
    const nextIndex = this.nextIndex(state);
    if (nextIndex !== -1) {
      this.loadTrack(nextIndex);
      void this.startPlayback({ skip: 1 });
    }
  }

  private prev() {
    const state = this.active();
    if (!state) return;
    const prevIndex = this.stepPlayable(state.lastIndex, -1);
    if (prevIndex !== -1) {
      this.loadTrack(prevIndex);
      void this.startPlayback({ skip: -1 });
    }
  }

  // The track next() plays, or -1 when there is none.
  private nextIndex(state: PlaylistState): number {
    if (state.nextIsCurrent && !state.tracks[state.lastIndex]?.unplayable) return state.lastIndex;
    return this.stepPlayable(state.lastIndex, 1);
  }

  // The index of the first playable track after (dir 1) or before (dir -1)
  // `fromIndex` in play order, or -1 when there is none.
  private stepPlayable(fromIndex: number, dir: 1 | -1): number {
    const state = this.active();
    if (!state) return -1;
    const order = playOrder(state);
    let position = order.indexOf(fromIndex) + dir;
    while (position >= 0 && position < order.length) {
      const index = order[position]!;
      if (!state.tracks[index]!.unplayable) return index;
      position += dir;
    }
    return -1;
  }

  private toggleReversed() {
    const state = this.active();
    if (!state || this.activeId === null) return;
    const id = this.activeId;
    this.applyReversed(id, state, !state.reversed);
    this.reversedPlaylists = { ...this.reversedPlaylists, [id]: state.reversed };
    // Read before writing, so a choice made in another tab is kept.
    chrome.storage.local.get('reversedPlaylists', (result) => {
      const saved = (result['reversedPlaylists'] ?? {}) as Partial<Record<PlaylistId, boolean>>;
      chrome.storage.local.set({ reversedPlaylists: { ...saved, [id]: state.reversed } });
    });
    this.clearPreloaded();
    if (!this.audio.paused) void this.preloadUpcoming();
    this.updateHeader();
    this.updateQueueEl();
    this.updateNavButtons();
  }

  private updateNavButtons() {
    const state = this.active();
    if (!state) {
      this.prevBtn.disabled = true;
      this.nextBtn.disabled = true;
      return;
    }
    this.prevBtn.disabled = this.stepPlayable(state.lastIndex, -1) === -1;
    this.nextBtn.disabled = this.nextIndex(state) === -1;
  }

  private toggleQueue() {
    this.queueVisible = !this.queueVisible;
    this.queueEl.classList.toggle('bcp-visible', this.queueVisible);
    if (this.queueVisible) this.scrollQueueToActive();
  }

  private togglePlayer() {
    this.playerVisible = !this.playerVisible;
    this.wrapper.classList.toggle('bcp-collapsed', !this.playerVisible);
    this.collapseBtn.textContent = this.playerVisible ? 'Hide player ▼' : 'Show player ▲';
    this.collapseBtn.title = this.playerVisible ? 'Hide player' : 'Show player';
    if (this.playerVisible && this.queueVisible) this.scrollQueueToActive();
  }

  // Centres the playing track in the queue. Sets the queue's own scrollTop
  // rather than using scrollIntoView, which would also scroll the page.
  private scrollQueueToActive() {
    const item = this.queueEl.querySelector<HTMLElement>('.bcp-queue-item.bcp-active');
    if (!item) return;
    const offset = item.getBoundingClientRect().top - this.queueEl.getBoundingClientRect().top;
    this.queueEl.scrollTop += offset - (this.queueEl.clientHeight - item.offsetHeight) / 2;
  }

  private updateCartActions(track: PlaylistTrack) {
    this.cartActionsEl.innerHTML = '';

    if (!track.releaseId) return;

    if (this.isInCart(track)) {
      // Determine which URL the cart holds: individual track adds use track.pageUrl,
      // release/album adds use track.releaseUrl.
      const cartItemUrl = this.cartItemKeyFor(track);
      // If the individual track URL is NOT in cartUrls the album was purchased as a whole.
      const inCartAsAlbum = !this.cartUrls.has(normalizeUrl(track.pageUrl));

      const removeBtn = btn('Remove', 'bcp-cart-action-btn bcp-remove-btn');
      removeBtn.addEventListener('click', async () => {
        const releaseLabel = track.albumTitle || track.trackTitle || 'this release';
        const confirmed = await this.showConfirm(
          'Remove from cart',
          `Remove "${releaseLabel}" from your cart?`
        );
        if (!confirmed) return;
        removeBtn.disabled = true;
        await this.onCartRemove?.(track, cartItemUrl);
        removeBtn.disabled = false;
      });

      const badge = el('span', 'bcp-in-cart-badge');
      badge.textContent = inCartAsAlbum ? '✓ In cart (full album)' : '✓ In cart';
      this.cartActionsEl.append(badge, removeBtn);
    } else {
      // Always show both buttons so the layout is the same for every track.
      // A single-track release is added through "+ Track" (the track is the
      // release); its "+ Release" adds the album the track page links to, and is
      // greyed out when there is none. An album track without a track id can
      // only be bought as part of the release.
      const isAlbum = track.releaseType === 'album';
      const canAddRelease = isAlbum || !!track.albumUrl;
      const trackAddType: 'track' | 'release' | null = !isAlbum
        ? 'release'
        : track.trackId !== null ? 'track' : null;

      const addTrackBtn = btn('+ Track', 'bcp-cart-action-btn');
      if (trackAddType !== null && track.purchasable) {
        addTrackBtn.title = 'Add this track to cart';
        addTrackBtn.addEventListener('click', async () => {
          addTrackBtn.disabled = true;
          const ok = await this.onCartAdd?.(track, trackAddType);
          if (ok === false) {
            addTrackBtn.classList.add('bcp-disabled');
            addTrackBtn.title = 'Only full release for sale';
          } else {
            addTrackBtn.disabled = false;
          }
        });
      } else {
        addTrackBtn.classList.add('bcp-disabled');
        addTrackBtn.title = 'Only full release for sale';
      }

      const addReleaseBtn = btn('+ Release', 'bcp-cart-action-btn');
      if (canAddRelease) {
        addReleaseBtn.title = 'Add the full release to cart';
        addReleaseBtn.addEventListener('click', async () => {
          addReleaseBtn.disabled = true;
          await this.onCartAdd?.(track, isAlbum ? 'release' : 'album');
          addReleaseBtn.disabled = false;
        });
      } else {
        addReleaseBtn.classList.add('bcp-disabled');
        addReleaseBtn.title = 'Single-track release: use + Track';
      }

      this.cartActionsEl.append(addTrackBtn, addReleaseBtn);
    }
  }

  private showConfirm(title: string, body: string): Promise<boolean> {
    return new Promise((resolve) => {
      const backdrop = el('div', 'bcp-modal-backdrop');

      const modal = el('div', 'bcp-modal');

      const titleEl = el('div', 'bcp-modal-title');
      titleEl.textContent = title;

      const bodyEl = el('div', 'bcp-modal-body');
      bodyEl.textContent = body;

      const actions = el('div', 'bcp-modal-actions');
      const cancelBtn = btn('Cancel', 'bcp-modal-btn');
      const confirmBtn = btn('Remove', 'bcp-modal-btn bcp-modal-btn-destructive');

      const close = (result: boolean) => {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') close(false);
      };

      cancelBtn.addEventListener('click', () => close(false));
      confirmBtn.addEventListener('click', () => close(true));
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(false);
      });
      document.addEventListener('keydown', onKey);

      actions.append(cancelBtn, confirmBtn);
      modal.append(titleEl, bodyEl, actions);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
    });
  }

  private updateTempoUI() {
    const range = TEMPO_RANGES[this.tempoRangeIndex]!;
    this.tempoSlider.min = String(range.min);
    this.tempoSlider.max = String(range.max);
    this.tempoSlider.value = String(this.playbackRate);
    const pct = (this.playbackRate - 1) * 100;
    const sign = pct >= 0 ? '+' : '';
    this.tempoResetBtn.textContent = `${sign}${pct.toFixed(1)}%`;
    this.tempoRangeBtn.textContent = `(${range.label})`;
    this.tempoMTBtn.classList.toggle('bcp-tempo-btn-active', this.preservesPitch);
  }


}

// Runs of consecutive tracks from the same release, as lists of track indices.
function releaseBlocks(tracks: PlaylistTrack[]): number[][] {
  const blocks: number[][] = [];
  let previousRelease: string | null = null;
  tracks.forEach((track, i) => {
    const release = normalizeUrl(track.releaseUrl);
    if (release === previousRelease) blocks[blocks.length - 1]!.push(i);
    else blocks.push([i]);
    previousRelease = release;
  });
  return blocks;
}

// Track indices in the order they play: as listed, or with the releases
// reversed while each release still plays from its first track.
function playOrder(state: Pick<PlaylistState, 'tracks' | 'reversed'>): number[] {
  if (!state.reversed) return state.tracks.map((_, i) => i);
  return releaseBlocks(state.tracks).reverse().flat();
}

// The first playable track in play order, or the first track when none is.
function firstPlayable(state: Pick<PlaylistState, 'tracks' | 'reversed'>): number {
  const order = playOrder(state);
  return order.find((i) => !state.tracks[i]!.unplayable) ?? order[0] ?? 0;
}

function injectStyles() {
  if (document.getElementById('bcp-styles')) return;
  const style = document.createElement('style');
  style.id = 'bcp-styles';
  style.textContent = PLAYER_CSS;
  document.head.appendChild(style);
}

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function btn(text: string, className: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = className;
  return b;
}

function unloadAudio(audio: HTMLAudioElement) {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

