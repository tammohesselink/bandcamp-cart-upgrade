import type { PlaylistId, PlaylistTrack } from './types';
import { PLAYER_CSS } from './styles';

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
  private titleEl!: HTMLElement;
  private subEl!: HTMLElement;
  private playPauseBtn!: HTMLButtonElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private seekBar!: HTMLInputElement;
  private currentTimeEl!: HTMLElement;
  private totalTimeEl!: HTMLElement;
  private volumeBar!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private queueToggleBtn!: HTMLButtonElement;

  private queueVisible = false;
  private seeking = false;

  constructor(initialPlaylist: PlaylistTrack[]) {
    this.audio = new Audio();

    injectStyles();

    this.wrapper = document.createElement('div');
    this.wrapper.id = 'bcp-wrapper';

    this.queueEl = this.buildQueueEl();
    this.headerEl = this.buildHeaderEl();
    this.bar = this.buildBarEl();

    this.wrapper.appendChild(this.queueEl);
    this.wrapper.appendChild(this.headerEl);
    this.wrapper.appendChild(this.bar);

    this.bindAudioEvents();
    this.alignToPageContent();
    window.addEventListener('resize', () => this.alignToPageContent());

    if (initialPlaylist.length > 0) {
      this.setPlaylist('cart', 'Cart', initialPlaylist);
    }
  }

  // --- Public API -----------------------------------------------------------

  setPlaylist(id: PlaylistId, label: string, tracks: PlaylistTrack[]) {
    const isNew = !this.playlists.has(id);
    this.playlists.set(id, { label, tracks, lastIndex: 0, statusMsg: '', statusKind: 'info' });
    this.updateHeader();
    if (isNew && this.playlists.size === 1) {
      this.selectPlaylist(id);
    }
  }

  selectPlaylist(id: PlaylistId) {
    const state = this.playlists.get(id);
    if (!state) return;
    this.audio.pause();
    this.activeId = id;
    this.updateHeader();
    this.updateQueueEl();
    this.loadTrack(state.lastIndex);
    if (state.statusMsg) {
      this.setStatus(state.statusMsg, state.statusKind);
    }
  }

  jumpTo(id: PlaylistId, index: number) {
    if (this.activeId !== id) {
      this.selectPlaylist(id);
    }
    this.loadTrack(index);
    this.audio.play().catch(console.warn);
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

  // --- Private helpers -------------------------------------------------------

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

    const entries: [PlaylistId, string][] = [
      ['cart', 'Cart'],
      ['discography', 'Label discography'],
    ];

    for (const [id, label] of entries) {
      const state = this.playlists.get(id);
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
    this.titleEl = el('div', 'bcp-track-title');
    this.titleEl.textContent = 'No tracks loaded';
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
      this.audio.currentTime = (parseFloat(this.seekBar.value) / 100) * this.audio.duration;
    });

    const seekArea = el('div', 'bcp-seek-area');
    seekArea.append(this.currentTimeEl, this.seekBar, this.totalTimeEl);

    this.volumeBar = el('input', 'bcp-range bcp-volume') as HTMLInputElement;
    this.volumeBar.type = 'range';
    this.volumeBar.min = '0';
    this.volumeBar.max = '100';
    this.volumeBar.value = '80';
    this.audio.volume = 0.8;
    this.volumeBar.addEventListener('input', () => {
      this.audio.volume = parseFloat(this.volumeBar.value) / 100;
    });

    const volIcon = el('span', 'bcp-vol-icon');
    volIcon.textContent = '🔊';
    const volArea = el('div', 'bcp-volume-area');
    volArea.append(volIcon, this.volumeBar);

    this.queueToggleBtn = btn('☰', 'bcp-btn');
    this.queueToggleBtn.title = 'Toggle queue';
    this.queueToggleBtn.addEventListener('click', () => this.toggleQueue());

    this.statusEl = el('div', 'bcp-status');

    bar.append(
      this.artworkEl,
      trackInfo,
      controls,
      seekArea,
      volArea,
      this.queueToggleBtn,
      this.statusEl
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

  private loadTrack(index: number) {
    const state = this.active();
    if (!state) return;

    state.lastIndex = index;
    const track = state.tracks[index];
    if (!track) return;

    this.artworkEl.src = track.artworkUrl || '';
    this.titleEl.textContent = track.trackTitle || '(untitled)';
    this.subEl.textContent = [track.artist, track.albumTitle].filter(Boolean).join(' — ');
    this.currentTimeEl.textContent = '0:00';
    this.totalTimeEl.textContent = fmtTime(track.durationSec);
    this.seekBar.value = '0';
    this.updateNavButtons();
    this.updateQueueEl();

    if (track.unplayable || !track.streamUrl) {
      this.playPauseBtn.textContent = '▶';
      this.playPauseBtn.disabled = true;
      return;
    }

    this.playPauseBtn.disabled = false;
    this.audio.src = track.streamUrl;
    this.audio.load();
  }

  private bindAudioEvents() {
    this.audio.addEventListener('play', () => {
      this.playPauseBtn.textContent = '⏸';
    });

    this.audio.addEventListener('pause', () => {
      this.playPauseBtn.textContent = '▶';
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

  private alignToPageContent() {
    const container =
      document.getElementById('pgBd') ??
      document.querySelector<HTMLElement>('.yui-skin-sam');
    if (!container) return;
    const { left, width } = container.getBoundingClientRect();
    this.wrapper.style.left = `${left}px`;
    this.wrapper.style.width = `${width}px`;
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
