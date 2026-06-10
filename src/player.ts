import type { PlaylistId, PlaylistTrack } from './types';
import { PLAYER_CSS } from './styles';
import { normalizeUrl } from './url';

type CartAddType = 'track' | 'release';

const TEMPO_RANGES = [
  { label: '±6',   min: 0.94, max: 1.06 },
  { label: '±10',  min: 0.90, max: 1.10 },
  { label: '±16',  min: 0.84, max: 1.16 },
  { label: 'WIDE', min: 0.10, max: 2.00 },
] as const;

type StatusKind = 'loading' | 'error' | 'warn' | 'info';

interface PlaylistState {
  label: string;
  tracks: PlaylistTrack[];
  lastIndex: number;
  statusMsg: string;
  statusKind: StatusKind;
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
  private statusEl!: HTMLElement;
  private queueToggleBtn!: HTMLButtonElement;
  private reloadBtn!: HTMLButtonElement;

  private queueVisible = false;
  private playerVisible = true;
  private discographyExpected = false;
  private collapseBtn!: HTMLButtonElement;
  private seeking = false;

  private cartUrls = new Set<string>();
  private cartActionsEl!: HTMLElement;

  onCartAdd?: (track: PlaylistTrack, addType: CartAddType) => Promise<boolean | void>;
  onCartRemove?: (track: PlaylistTrack, cartItemUrl: string) => Promise<void>;
  onCheckoutSelected?: (selectedRawUrls: string[]) => Promise<void>;
  onPlaybackStart?: () => void;
  onCurrentPageTrackChange?: (pageUrl: string) => void;
  onTrackChange?: (id: PlaylistId, index: number) => void;
  onSeek?: (fraction: number) => void;
  onDiscographyButtonVisibilityChange?: (show: boolean) => void;
  onReloadPlaylist?: () => Promise<void>;

  constructor(initialPlaylist: PlaylistTrack[]) {
    this.audio = new Audio();
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

    this.bindAudioEvents();
    this.setupMediaSession();

    chrome.storage.local.get(['tempoRangeIndex', 'preservesPitch', 'showDiscographyButton'], (result) => {
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

  expectDiscography() {
    this.discographyExpected = true;
    this.updateHeader();
  }

  setPlaylist(id: PlaylistId, label: string, tracks: PlaylistTrack[]) {
    const isNew = !this.playlists.has(id);
    this.playlists.set(id, { label, tracks, lastIndex: 0, statusMsg: '', statusKind: 'info' });
    this.updateHeader();
    if (isNew && this.playlists.size === 1) {
      this.selectPlaylist(id);
    }
  }

  selectPlaylist(id: PlaylistId, silent = false) {
    const state = this.playlists.get(id);
    if (!state) return;
    this.audio.pause();
    this.activeId = id;
    this.updateHeader();
    this.updateQueueEl();
    this.loadTrack(state.lastIndex, silent);
    if (state.statusMsg) {
      this.setStatus(state.statusMsg, state.statusKind);
    }
  }

  jumpTo(id: PlaylistId, index: number, silent = false) {
    if (this.activeId !== id) {
      this.selectPlaylist(id, silent);
    }
    this.loadTrack(index, silent);
    this.audio.play().catch(console.warn);
  }

  showToast(msg: string, kind: StatusKind = 'info') {
    const toast = el('div', `bcp-toast bcp-toast-${kind}`);
    toast.textContent = msg;
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
    if (this.activeId === id) this.updateQueueEl();
    return startIndex;
  }

  getPlaylistTracks(id: PlaylistId): PlaylistTrack[] {
    return this.playlists.get(id)?.tracks ?? [];
  }

  pause() {
    this.audio.pause();
  }

  play() {
    this.audio.play().catch(console.warn);
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
    this.wrapper.remove();
    document.body.style.paddingBottom = '';
  }

  removeTracksByReleaseUrl(id: PlaylistId, releaseUrl: string) {
    const state = this.playlists.get(id);
    if (!state) return;
    const normalized = normalizeUrl(releaseUrl);
    const removedBefore = state.tracks
      .slice(0, state.lastIndex)
      .filter((t) => normalizeUrl(t.releaseUrl) === normalized).length;
    const currentRemoved =
      normalizeUrl(state.tracks[state.lastIndex]?.releaseUrl ?? '') === normalized;
    state.tracks = state.tracks.filter((t) => normalizeUrl(t.releaseUrl) !== normalized);
    // Adjust lastIndex so next() advances to the right track after the audio ends.
    // When the current track is removed, step back one extra so next() lands on
    // the first surviving track after the removed section.
    const adjustment = currentRemoved ? removedBefore + 1 : removedBefore;
    state.lastIndex = Math.min(
      Math.max(0, state.lastIndex - adjustment),
      Math.max(0, state.tracks.length - 1)
    );
    if (this.activeId === id) {
      // Don't touch the audio — let the current stream finish naturally.
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
    const isCurrentTrack = idx === state.lastIndex;
    state.tracks.splice(idx, 1);
    if (idx < state.lastIndex) {
      state.lastIndex = Math.max(0, state.lastIndex - 1);
    } else if (isCurrentTrack) {
      state.lastIndex = Math.min(state.lastIndex, Math.max(0, state.tracks.length - 1));
    }
    if (this.activeId === id) {
      this.updateQueueEl();
      this.updateNavButtons();
    }
  }

  // --- Private helpers -------------------------------------------------------

  // Returns the cart-item key for a track: pageUrl for single-track purchases
  // (where Bandcamp stores the track page URL in the sidecart), releaseUrl for
  // full-release purchases. This is the URL used as the key in cartUrls and is
  // the unit of selection for partial checkout.
  private cartItemKeyFor(track: PlaylistTrack): string {
    return this.cartUrls.has(normalizeUrl(track.pageUrl)) ? track.pageUrl : track.releaseUrl;
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

    const entries: [PlaylistId, string][] = [
      ['currentpage', 'Current page'],
      ['discography', 'Label discography'],
      ['cart', 'Cart'],
    ];

    for (const [id, label] of entries) {
      const state = this.playlists.get(id);
      if (!state && (id !== 'discography' || !this.discographyExpected)) continue;
      const tab = document.createElement('button');
      tab.className = 'bcp-tab' + (id === this.activeId ? ' bcp-tab-active' : '');
      tab.textContent = state?.label ?? label;
      if (state) {
        tab.addEventListener('click', () => this.selectPlaylist(id));
      } else {
        tab.disabled = true;
      }
      tabs.appendChild(tab);
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

    this.tempoResetBtn = btn('+0.0%', 'bcp-btn bcp-tempo-btn');
    this.tempoResetBtn.title = 'Reset tempo';
    this.tempoResetBtn.addEventListener('click', () => {
      this.playbackRate = 1;
      this.audio.playbackRate = 1;
      this.updateTempoUI();
    });

    this.tempoRangeBtn = btn('(±10)', 'bcp-btn bcp-tempo-btn');
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

    state.tracks.forEach((track, i) => {
      const item = el('div', 'bcp-queue-item');
      if (i === state.lastIndex) item.classList.add('bcp-active');
      if (track.unplayable) item.classList.add('bcp-unplayable');

      const num = el('div', 'bcp-queue-num');
      num.textContent = String(i + 1);

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
          this.audio.play().catch(console.warn);
        });
      }

      this.queueEl.appendChild(item);
    });
  }

  private loadTrack(index: number, silent = false) {
    const state = this.active();
    if (!state) return;

    state.lastIndex = index;
    const track = state.tracks[index];
    if (!track) return;

    this.onTrackChange?.(this.activeId!, index);

    // Only reload when the stream URL actually changes. Keeping the same src
    // preserves the current playback position across pause/resume cycles (e.g.
    // when the native Bandcamp player triggers a play event for a track the
    // bottom player already has loaded mid-way through).
    const needsReload = !track.streamUrl || track.unplayable || track.streamUrl !== this.audio.src;

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
      this.playPauseBtn.textContent = '▶';
      this.playPauseBtn.disabled = true;
      return;
    }

    this.playPauseBtn.disabled = false;
    if (needsReload) {
      this.audio.src = track.streamUrl;
      this.audio.load();
      this.audio.playbackRate = this.playbackRate;
      this.audio.preservesPitch = this.preservesPitch;
    }
  }

  private bindAudioEvents() {
    this.audio.addEventListener('play', () => {
      this.playPauseBtn.textContent = '⏸';
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      this.onPlaybackStart?.();
    });

    this.audio.addEventListener('pause', () => {
      this.playPauseBtn.textContent = '▶';
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    });

    this.audio.addEventListener('timeupdate', () => {
      if (this.seeking || !isFinite(this.audio.duration)) return;
      this.currentTimeEl.textContent = fmtTime(this.audio.currentTime);
      this.seekBar.value = String((this.audio.currentTime / this.audio.duration) * 100);
    });

    this.audio.addEventListener('loadedmetadata', () => {
      this.totalTimeEl.textContent = fmtTime(this.audio.duration);
    });

    this.audio.addEventListener('ended', () => {
      this.next();
    });

    this.audio.addEventListener('error', () => {
      console.warn('[bcp] Audio error for track', this.active()?.lastIndex, this.audio.error);
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
    if (this.audio.paused) {
      this.audio.play().catch(console.warn);
    } else {
      this.audio.pause();
    }
  }

  private next() {
    const state = this.active();
    if (!state) return;
    const nextIndex = this.nextPlayable(state.lastIndex + 1, 1);
    if (nextIndex !== -1) {
      this.loadTrack(nextIndex);
      this.audio.play().catch(console.warn);
    }
  }

  private prev() {
    const state = this.active();
    if (!state) return;
    const prevIndex = this.nextPlayable(state.lastIndex - 1, -1);
    if (prevIndex !== -1) {
      this.loadTrack(prevIndex);
      this.audio.play().catch(console.warn);
    }
  }

  private nextPlayable(start: number, dir: 1 | -1): number {
    const state = this.active();
    if (!state) return -1;
    let i = start;
    while (i >= 0 && i < state.tracks.length) {
      if (!state.tracks[i]!.unplayable) return i;
      i += dir;
    }
    return -1;
  }

  private updateNavButtons() {
    const state = this.active();
    if (!state) {
      this.prevBtn.disabled = true;
      this.nextBtn.disabled = true;
      return;
    }
    this.prevBtn.disabled = this.nextPlayable(state.lastIndex - 1, -1) === -1;
    this.nextBtn.disabled = this.nextPlayable(state.lastIndex + 1, 1) === -1;
  }

  private toggleQueue() {
    this.queueVisible = !this.queueVisible;
    this.queueEl.classList.toggle('bcp-visible', this.queueVisible);
  }

  private togglePlayer() {
    this.playerVisible = !this.playerVisible;
    this.wrapper.classList.toggle('bcp-collapsed', !this.playerVisible);
    this.collapseBtn.textContent = this.playerVisible ? 'Hide player ▼' : 'Show player ▲';
    this.collapseBtn.title = this.playerVisible ? 'Hide player' : 'Show player';
    document.body.style.paddingBottom = this.playerVisible ? '90px' : '0';
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
      if (track.releaseType === 'album' && track.trackId !== null) {
        const addTrackBtn = btn('+ Track', 'bcp-cart-action-btn');
        if (track.purchasable) {
          addTrackBtn.title = 'Add this track to cart';
          addTrackBtn.addEventListener('click', async () => {
            addTrackBtn.disabled = true;
            const ok = await this.onCartAdd?.(track, 'track');
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
        addReleaseBtn.title = 'Add the full release to cart';
        addReleaseBtn.addEventListener('click', async () => {
          addReleaseBtn.disabled = true;
          await this.onCartAdd?.(track, 'release');
          addReleaseBtn.disabled = false;
        });

        this.cartActionsEl.append(addTrackBtn, addReleaseBtn);
      } else {
        const addCartBtn = btn('+ Cart', 'bcp-cart-action-btn');
        if (track.purchasable) {
          addCartBtn.title = 'Add to cart';
          addCartBtn.addEventListener('click', async () => {
            addCartBtn.disabled = true;
            const ok = await this.onCartAdd?.(track, 'release');
            if (ok === false) {
              addCartBtn.classList.add('bcp-disabled');
              addCartBtn.title = 'Only full release for sale';
            } else {
              addCartBtn.disabled = false;
            }
          });
        } else {
          addCartBtn.classList.add('bcp-disabled');
          addCartBtn.title = 'Only full release for sale';
        }

        this.cartActionsEl.append(addCartBtn);
      }
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

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

