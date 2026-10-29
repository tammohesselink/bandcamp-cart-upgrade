export const PLAYER_CSS = `
#bcp-wrapper {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 2147483647;
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #333;
  box-sizing: border-box;
  /* The open queue only fills the right third, leaving a transparent strip
     beside it that would otherwise swallow clicks meant for the page. */
  pointer-events: none;
}

#bcp-wrapper > * {
  pointer-events: auto;
}

#bcp-collapse-btn {
  position: absolute;
  /* 1px down so the tab covers the panel's top border below it. */
  top: 1px;
  right: 16px;
  transform: translateY(-100%);
  background: #fff;
  border: 1px solid #ccc;
  border-bottom: none;
  color: #777;
  cursor: pointer;
  padding: 3px 9px;
  font-family: inherit;
  font-size: 11px;
  border-radius: 4px 4px 0 0;
  line-height: 1.4;
  transition: color 0.15s;
}

#bcp-collapse-btn:hover {
  color: #333;
}

#bcp-wrapper.bcp-collapsed #bcp-queue,
#bcp-wrapper.bcp-collapsed #bcp-header,
#bcp-wrapper.bcp-collapsed #bcp-bar {
  display: none;
}

#bcp-wrapper * {
  box-sizing: border-box;
}

#bcp-queue {
  background: #fff;
  border-top: 1px solid #ccc;
  border-left: 1px solid #ccc;
  max-height: 300px;
  overflow-y: auto;
  display: none;
  width: 33.333%;
  margin-left: auto;
}

#bcp-queue.bcp-visible {
  display: block;
}

.bcp-queue-item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  gap: 10px;
  cursor: pointer;
  border-bottom: 1px solid #f0f0f0;
  transition: background 0.1s;
  user-select: none;
}

.bcp-queue-item:hover {
  background: #f5f5f5;
}

.bcp-queue-item.bcp-active {
  background: #eaf6fa;
  border-left: 3px solid #1da0c3;
  padding-left: 13px;
}

.bcp-queue-item.bcp-unplayable {
  opacity: 0.45;
  cursor: default;
}

.bcp-queue-num {
  color: #aaa;
  font-size: 11px;
  min-width: 20px;
  text-align: right;
}

.bcp-queue-text {
  flex-grow: 1;
  min-width: 0;
}

.bcp-queue-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #333;
}

.bcp-queue-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #888;
  font-size: 11px;
  margin-top: 1px;
}

.bcp-no-stream {
  color: #c94c4c;
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
}

/* The header and bar read as one panel, like Bandcamp's docked player. */
#bcp-header {
  background: #fff;
  border-top: 1px solid #ccc;
  padding: 6px 10px 0;
  font-size: 12px;
  color: #999;
  user-select: none;
}

#bcp-bar {
  background: #fff;
  min-height: 78px;
  display: flex;
  align-items: center;
  padding: 8px 10px;
  gap: 16px;
}

#bcp-artwork {
  width: 60px;
  height: 60px;
  object-fit: cover;
  flex-shrink: 0;
  background: #eee;
}

.bcp-track-info {
  min-width: 0;
  width: 260px;
  flex-shrink: 0;
}

.bcp-release-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
  color: #333;
  text-decoration: none;
}

.bcp-release-title[href]:hover {
  text-decoration: underline;
}

.bcp-track-artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #333;
}

.bcp-center {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 840px;
  margin: 0 auto;
}

/* Track title and time above the seek bar; prev/next beside the bar. */
.bcp-progress {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 12px;
  row-gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
}

.bcp-track-row {
  grid-column: 1;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.bcp-track-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  color: #333;
  text-decoration: none;
}

.bcp-track-title[href]:hover {
  text-decoration: underline;
}

.bcp-time {
  flex-shrink: 0;
  font-size: 12px;
  color: #333;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.bcp-controls {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  align-items: center;
  gap: 2px;
}

.bcp-btn {
  background: none;
  border: none;
  color: #777;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 16px;
  line-height: 1;
  transition: color 0.15s, border-color 0.15s;
}

.bcp-btn:hover:not(:disabled) {
  color: #333;
}

.bcp-btn:disabled {
  color: #ddd;
  cursor: default;
}

.bcp-icon {
  display: block;
  width: 1em;
  height: 1em;
  fill: currentColor;
}

.bcp-btn-play {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  padding: 0;
  font-size: 20px;
  color: #222;
  background: #fff;
  border: 1px solid #d9d9d9;
  border-radius: 2px;
}

.bcp-btn-play .bcp-icon {
  width: 26px;
  height: 26px;
}

.bcp-btn-play:hover:not(:disabled) {
  color: #000;
  border-color: #999;
}

.bcp-btn-play:disabled {
  color: #ccc;
}

.bcp-nav-btn {
  padding: 2px;
  font-size: 18px;
  color: #999;
}

.bcp-spinner {
  display: inline-block;
  box-sizing: border-box;
  width: 1em;
  height: 1em;
  vertical-align: middle;
  border: 2px solid rgba(0, 0, 0, 0.15);
  border-top-color: #333;
  border-radius: 50%;
  animation: bcp-spin 0.8s linear infinite;
}

@keyframes bcp-spin {
  to { transform: rotate(360deg); }
}

/* --bcp-fill is set from script to how far the thumb is along. */
input[type=range].bcp-range {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  margin: 0;
  border-radius: 2px;
  background: linear-gradient(to right, #999 var(--bcp-fill, 0%), #e2e2e2 var(--bcp-fill, 0%));
  cursor: pointer;
  outline: none;
  border: none;
}

input[type=range].bcp-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #555;
  cursor: pointer;
}

input[type=range].bcp-seek {
  grid-column: 1;
  width: 100%;
  height: 8px;
  border-radius: 0;
  background: linear-gradient(to right, #aaa var(--bcp-fill, 0%), #e6e6e6 var(--bcp-fill, 0%));
}

input[type=range].bcp-seek::-webkit-slider-thumb {
  width: 5px;
  height: 12px;
  border-radius: 1px;
  background: #333;
}

input[type=range].bcp-tempo {
  width: 96px;
  flex-shrink: 0;
}

.bcp-side {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
  margin-left: auto;
}

.bcp-tempo-area {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.bcp-tempo-label {
  color: #777;
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
}

.bcp-tempo-btn {
  font-size: 10px;
  padding: 2px 5px;
  border: 1px solid #ccc;
  border-radius: 3px;
  color: #777;
  white-space: nowrap;
}

.bcp-tempo-btn:hover:not(:disabled) {
  border-color: #999;
}

.bcp-tempo-btn-active {
  color: #1da0c3;
  border-color: #1da0c3;
}

.bcp-status {
  font-size: 11px;
  color: #777;
  text-align: right;
  max-width: 160px;
}

.bcp-status-loading {
  color: #1da0c3;
}

.bcp-status-error {
  color: #c94c4c;
}

.bcp-status-warn {
  color: #b7791f;
}

.bcp-volume {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bcp-volume-btn {
  padding: 2px;
  font-size: 20px;
  color: #555;
}

input[type=range].bcp-volume-slider {
  width: 60px;
  height: 2px;
  border-radius: 0;
  background: linear-gradient(to right, #333 var(--bcp-fill, 0%), #ccc var(--bcp-fill, 0%));
}

input[type=range].bcp-volume-slider::-webkit-slider-thumb {
  width: 10px;
  height: 10px;
  background: #333;
}

.bcp-cart-play-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: #1da0c3;
  font-size: 11px;
  padding: 0 5px 0 0;
  vertical-align: middle;
  opacity: 0.7;
  transition: opacity 0.15s;
  line-height: 1;
}

.bcp-cart-play-btn:hover {
  opacity: 1;
}

.bcp-discography-btn {
  display: block;
  margin-bottom: 10px;
  padding: 7px 14px;
  background: #1da0c3;
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  opacity: 1;
  transition: opacity 0.15s;
}

.bcp-discography-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.bcp-discography-btn:disabled {
  background: #333;
  color: #666;
  cursor: default;
}

#bcp-tabs {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-grow: 1;
}

.bcp-tab {
  background: none;
  border: 1px solid #ccc;
  color: #777;
  cursor: pointer;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 11px;
  font-family: inherit;
  transition: color 0.15s, border-color 0.15s;
}

.bcp-tab:hover {
  color: #333;
  border-color: #999;
}

.bcp-tab.bcp-tab-active {
  color: #1da0c3;
  border-color: #1da0c3;
}

.bcp-tab.bcp-tab-unavailable {
  color: #bbb;
  border-color: #e2e2e2;
  border-style: dashed;
  cursor: help;
}

.bcp-tab.bcp-reverse-btn {
  margin-left: auto;
}

.bcp-tab.bcp-reverse-btn.bcp-tab-unavailable {
  cursor: default;
}

.bcp-tab.bcp-tab-unavailable.bcp-tab-error,
.bcp-tab.bcp-tab-unavailable.bcp-tab-warn {
  color: #c08050;
  border-color: #ecd2bd;
}

.bcp-grid-play-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: #1da0c3;
  font-size: 11px;
  padding: 0 4px 0 0;
  vertical-align: middle;
  opacity: 0.7;
  transition: opacity 0.15s;
  line-height: 1;
}

.bcp-grid-play-btn:hover {
  opacity: 1;
}

.bcp-cart-play-btn.bcp-disabled,
.bcp-grid-play-btn.bcp-disabled {
  color: #888;
  opacity: 0.4;
  cursor: default;
}

/* Text links separated by dots, like "you own this · send as gift". */
.bcp-cart-actions {
  display: flex;
  align-items: center;
  margin-top: 3px;
  overflow: hidden;
  font-size: 12px;
  white-space: nowrap;
}

.bcp-cart-actions > * + *::before {
  content: '·';
  display: inline-block;
  margin: 0 5px;
  color: #999;
}

.bcp-in-cart-badge {
  color: #333;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
}

.bcp-cart-action-btn {
  background: none;
  border: none;
  padding: 0;
  color: #1da0c3;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  white-space: nowrap;
}

.bcp-cart-action-btn:hover:not(:disabled) {
  text-decoration: underline;
}

.bcp-cart-action-btn:disabled,
.bcp-cart-action-btn.bcp-disabled,
.bcp-cart-action-btn.bcp-disabled:hover {
  color: #bbb;
  cursor: default;
  text-decoration: none;
}

.bcp-remove-btn {
  color: #c94c4c;
}

.bcp-queue-cart-marker {
  color: #1da0c3;
  font-size: 11px;
  flex-shrink: 0;
  margin-left: auto;
}

.bcp-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.bcp-tag-btn.bcp-tag-btn-active {
  color: #b8900a;
}

.bcp-queue-tag-btn {
  background: none;
  border: none;
  color: #bbb;
  cursor: pointer;
  flex-shrink: 0;
  font-size: 11px;
  padding: 0 2px;
  transition: color 0.15s;
}

.bcp-queue-tag-btn:hover {
  color: #777;
}

.bcp-queue-tag-btn.bcp-queue-tag-btn-active {
  color: #b8900a;
}

.bcp-queue-tag-btn.bcp-queue-tag-btn-active:hover {
  color: #8a6c08;
}

.bcp-toast {
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  color: #333;
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-size: 15px;
  left: 50%;
  opacity: 0;
  padding: 16px 28px;
  pointer-events: none;
  position: fixed;
  top: 50%;
  transform: translateX(-50%) translateY(calc(-50% + 12px));
  transition: opacity 0.2s ease, transform 0.2s ease;
  white-space: nowrap;
  z-index: 2147483646;
}

.bcp-toast-visible {
  opacity: 1;
  transform: translateX(-50%) translateY(-50%);
}

.bcp-toast-error {
  border-color: #efc4c4;
  color: #c94c4c;
}

.bcp-toast-warn {
  border-color: #ecd8b0;
  color: #b7791f;
}

.bcp-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
}

.bcp-modal {
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  max-width: 360px;
  padding: 20px 24px;
  width: 90%;
}

.bcp-modal-title {
  color: #1a1a1a;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}

.bcp-modal-body {
  color: #555;
  font-size: 13px;
  margin-bottom: 16px;
}

.bcp-modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.bcp-modal-btn {
  background: #fff;
  border: 1px solid #ccc;
  border-radius: 4px;
  color: #333;
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  padding: 7px 16px;
  transition: background 0.15s, border-color 0.15s;
}

.bcp-modal-btn:hover {
  background: #f5f5f5;
}

.bcp-modal-btn-destructive {
  background: #c94c4c;
  border-color: #c94c4c;
  color: #fff;
}

.bcp-modal-btn-destructive:hover {
  background: #b33f3f;
  border-color: #b33f3f;
}

a.itemName.bcp-playing {
  color: #1da0c3 !important;
  font-weight: 600;
}

.music-grid-item.bcp-playing p.title {
  color: #1da0c3 !important;
  font-weight: 600;
}

/* Partial-checkout: checkboxes and button injected into Bandcamp's sidecart */

.bcp-cart-checkbox {
  accent-color: #1da0c3;
  cursor: pointer;
  height: 13px;
  margin: 0 4px 0 0;
  vertical-align: middle;
  width: 13px;
}

.bcp-checkout-selected-btn {
  display: block;
  margin: 6px 0 0;
  padding: 5px 10px;
  background: #1da0c3;
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: opacity 0.15s;
}

.bcp-checkout-selected-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.bcp-checkout-selected-btn:disabled {
  background: #ccc;
  color: #666;
  cursor: default;
}

@media (max-width: 1440px) {
  .bcp-tempo-label {
    display: none;
  }

  .bcp-track-info {
    width: 200px;
  }
}

@media (max-width: 1200px) {
  .bcp-tempo-reset-btn,
  .bcp-tempo-range-btn {
    display: none;
  }
}

@media (max-width: 860px) {
  #bcp-bar {
    flex-wrap: wrap;
    row-gap: 8px;
  }

  .bcp-track-info {
    flex: 1 1 120px;
    width: auto;
  }

  .bcp-center {
    order: 100;
    flex-basis: 100%;
    max-width: none;
  }
}

@media (max-width: 720px) {
  .bcp-status {
    display: none;
  }
}

@media (max-width: 520px) {
  .bcp-tempo-area,
  .bcp-volume-slider {
    display: none;
  }
}
`;

// Backdrop/card shell shared by the cart history, remove-purchased and
// named-cart modals, plus the named-cart modal's own rules
// and the sidecart's "Checkout a cart" button, which shows without a player.
export const MODAL_CSS = `
  .bcp-hb{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999999;display:flex;align-items:center;justify-content:center}
  .bcp-hm{background:#fff;color:#1a1a1a;border-radius:8px;padding:20px 24px;max-width:520px;width:90%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.3);font-family:inherit;font-size:14px}
  .bcp-hm h3{margin:0 0 14px;font-size:15px;font-weight:600}
  .bcp-hl{list-style:none;margin:0 0 16px;padding:0;overflow-y:auto;flex:1 1 auto}
  .bcp-hl li{padding:9px 8px;border-radius:4px;border-bottom:1px solid #f0f0f0}
  .bcp-hl li:last-child{border-bottom:none}
  .bcp-hl li.bcp-clickable{cursor:pointer}
  .bcp-hl li.bcp-clickable:hover{background:#f0f9fc}
  .bcp-ha{display:flex;justify-content:flex-end;flex-shrink:0}
  .bcp-ha button{padding:7px 16px;border-radius:4px;border:1px solid #ccc;cursor:pointer;font-size:13px;font-family:inherit}
  .bcp-hcl:hover{background:#f5f5f5}
  .bcp-nc-row{display:flex;align-items:center;gap:8px}
  .bcp-nc-row input[type=checkbox]{accent-color:#1da0c3;cursor:pointer}
  .bcp-nc-name{flex:1;font-size:13px}
  .bcp-nc-meta{color:#999;font-size:12px;white-space:nowrap}
  .bcp-nc-meta.bcp-nc-stale{color:#c98a00}
  .bcp-nc-items{list-style:none;margin:5px 0 0;padding:0 0 0 8px;font-size:12px}
  .bcp-nc-items li{padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
  .bcp-nc-new{display:flex;gap:6px;margin-top:4px;padding:8px;border-top:1px solid #f0f0f0}
  .bcp-nc-new input[type=text]{flex:1;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;font-family:inherit}
  .bcp-nc-new button{padding:5px 12px;border-radius:4px;border:1px solid #1da0c3;color:#1da0c3;background:none;cursor:pointer;font-size:12px;font-family:inherit}
  .bcp-nc-empty{color:#999;font-style:italic;padding:8px 0}
  .bcp-nc-checkout-btn{padding:4px 10px;border-radius:3px;border:1px solid #1da0c3;color:#1da0c3;background:none;cursor:pointer;font-size:12px;font-family:inherit;white-space:nowrap}
  .bcp-nc-checkout-btn:disabled{border-color:#ccc;color:#999;cursor:default}
  .bcp-nc-delete-btn{padding:4px 8px;border-radius:3px;border:1px solid #c0392b;color:#c0392b;background:none;cursor:pointer;font-size:11px;font-family:inherit;white-space:nowrap}
  .bcp-checkout-cart-btn {
    display: block;
    margin: 4px 0 0;
    padding: 5px 10px;
    background: none;
    color: #1da0c3;
    border: 1px solid #1da0c3;
    border-radius: 4px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .bcp-checkout-cart-btn:hover:not(:disabled) {
    opacity: 0.85;
  }

  .bcp-checkout-cart-btn:disabled {
    border-color: #ccc;
    color: #999;
    cursor: default;
  }
`;

export function ensureModalStyles(): void {
  if (document.getElementById('bcp-modal-styles')) return;
  const style = document.createElement('style');
  style.id = 'bcp-modal-styles';
  style.textContent = MODAL_CSS;
  document.head.appendChild(style);
}
