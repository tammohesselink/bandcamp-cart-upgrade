import type { PlaylistTrack } from './types';
import { PLAYER_CSS } from './styles';

export class Player {
  readonly wrapper: HTMLElement;
  private bar: HTMLElement;
  private queueEl: HTMLElement;

  private audio: HTMLAudioElement;
  private playlist: PlaylistTrack[];
  private currentIndex = -1;

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

  constructor(playlist: PlaylistTrack[]) {
    this.playlist = playlist;
    this.audio = new Audio();

    injectStyles();

    this.wrapper = document.createElement('div');
    this.wrapper.id = 'bcp-wrapper';

    this.queueEl = this.buildQueueEl();
    this.bar = this.buildBarEl();

    const header = document.createElement('div');
    header.id = 'bcp-header';
    header.textContent = 'Full cart in a single playlist';

    this.wrapper.appendChild(this.queueEl);
    this.wrapper.appendChild(header);
    this.wrapper.appendChild(this.bar);

    this.bindAudioEvents();
    this.updateQueueEl();

    if (playlist.length > 0) {
      this.loadTrack(0);
    }
  }

  jumpTo(index: number) {
    this.loadTrack(index);
    this.audio.play().catch(console.warn);
  }

  setStatus(msg: string, kind: 'loading' | 'error' | 'warn' | 'info' = 'info') {
    this.statusEl.textContent = msg;
    this.statusEl.className = `bcp-status bcp-status-${kind}`;
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
    this.queueEl.innerHTML = '';
    this.playlist.forEach((track, i) => {
      const item = el('div', 'bcp-queue-item');
      if (i === this.currentIndex) item.classList.add('bcp-active');
      if (track.unplayable) item.classList.add('bcp-unplayable');

      const num = el('div', 'bcp-queue-num');
      num.textContent = String(i + 1);

      const text = el('div', 'bcp-queue-text');
      const title = el('div', 'bcp-queue-title');
      title.textContent = track.trackTitle || '(untitled)';
      const sub = el('div', 'bcp-queue-sub');
      sub.textContent =
        [track.artist, track.albumTitle].filter(Boolean).join(' — ');
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
    this.currentIndex = index;
    const track = this.playlist[index];
    if (!track) return;

    this.artworkEl.src = track.artworkUrl || '';
    this.titleEl.textContent = track.trackTitle || '(untitled)';
    this.subEl.textContent =
      [track.artist, track.albumTitle].filter(Boolean).join(' — ');
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
      console.warn('[bcp] Audio error for track', this.currentIndex, this.audio.error);
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
    const nextIndex = this.nextPlayable(this.currentIndex + 1, 1);
    if (nextIndex !== -1) {
      this.loadTrack(nextIndex);
      this.audio.play().catch(console.warn);
    }
  }

  private prev() {
    const prevIndex = this.nextPlayable(this.currentIndex - 1, -1);
    if (prevIndex !== -1) {
      this.loadTrack(prevIndex);
      this.audio.play().catch(console.warn);
    }
  }

  // Finds the next playable track starting at `start`, stepping by `dir` (+1 or -1).
  private nextPlayable(start: number, dir: 1 | -1): number {
    let i = start;
    while (i >= 0 && i < this.playlist.length) {
      if (!this.playlist[i]!.unplayable) return i;
      i += dir;
    }
    return -1;
  }

  private updateNavButtons() {
    this.prevBtn.disabled = this.nextPlayable(this.currentIndex - 1, -1) === -1;
    this.nextBtn.disabled = this.nextPlayable(this.currentIndex + 1, 1) === -1;
  }

  private toggleQueue() {
    this.queueVisible = !this.queueVisible;
    this.queueEl.classList.toggle('bcp-visible', this.queueVisible);
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
