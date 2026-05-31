export const PLAYER_CSS = `
#bcp-wrapper {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #fff;
  box-sizing: border-box;
}

#bcp-wrapper * {
  box-sizing: border-box;
}

#bcp-queue {
  background: #1a1a1a;
  border-top: 1px solid #2e2e2e;
  border-left: 1px solid #2e2e2e;
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
  border-bottom: 1px solid #222;
  transition: background 0.1s;
  user-select: none;
}

.bcp-queue-item:hover {
  background: #2a2a2a;
}

.bcp-queue-item.bcp-active {
  background: #0d3a47;
  border-left: 3px solid #1da0c3;
  padding-left: 13px;
}

.bcp-queue-item.bcp-unplayable {
  opacity: 0.45;
  cursor: default;
}

.bcp-queue-num {
  color: #555;
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
  color: #e8e8e8;
}

.bcp-queue-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #777;
  font-size: 11px;
  margin-top: 1px;
}

.bcp-no-stream {
  color: #e05c5c;
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
}

#bcp-header {
  background: #111;
  border-top: 4px solid #1da0c3;
  padding: 5px 16px;
  font-size: 12px;
  color: #999;
  user-select: none;
}

#bcp-bar {
  background: #111;
  height: 72px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 14px;
}

#bcp-artwork {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 2px;
  flex-shrink: 0;
  background: #222;
}

.bcp-track-info {
  min-width: 0;
  width: 180px;
  flex-shrink: 0;
}

.bcp-track-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  color: #f0f0f0;
}

.bcp-track-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #888;
  font-size: 11px;
  margin-top: 2px;
}

.bcp-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.bcp-btn {
  background: none;
  border: none;
  color: #aaa;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 16px;
  line-height: 1;
  transition: color 0.15s;
}

.bcp-btn:hover:not(:disabled) {
  color: #1da0c3;
}

.bcp-btn:disabled {
  color: #444;
  cursor: default;
}

.bcp-btn-play {
  font-size: 20px;
  padding: 4px 10px;
  color: #fff;
}

.bcp-seek-area {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-grow: 1;
  min-width: 0;
}

.bcp-time {
  color: #777;
  font-size: 11px;
  white-space: nowrap;
  width: 36px;
  flex-shrink: 0;
}

.bcp-time-total {
  text-align: left;
}

.bcp-time-current {
  text-align: right;
}

input[type=range].bcp-range {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 2px;
  background: #333;
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
  background: #1da0c3;
  cursor: pointer;
}

input[type=range].bcp-seek {
  flex-grow: 1;
}

input[type=range].bcp-tempo {
  width: 96px;
  flex-shrink: 0;
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
  border: 1px solid #444;
  border-radius: 3px;
  color: #999;
  white-space: nowrap;
}

.bcp-tempo-btn:hover:not(:disabled) {
  border-color: #666;
}

.bcp-tempo-btn-active {
  color: #1da0c3;
  border-color: #1da0c3;
}

.bcp-status {
  font-size: 11px;
  color: #777;
  text-align: center;
  min-width: 80px;
}

.bcp-status-loading {
  color: #1da0c3;
}

.bcp-status-error {
  color: #e05c5c;
}

.bcp-status-warn {
  color: #e0a040;
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
  border: 1px solid #444;
  color: #999;
  cursor: pointer;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 11px;
  font-family: inherit;
  transition: color 0.15s, border-color 0.15s;
}

.bcp-tab:hover {
  color: #ccc;
  border-color: #666;
}

.bcp-tab.bcp-tab-active {
  color: #1da0c3;
  border-color: #1da0c3;
}

.bcp-tab:disabled {
  color: #444;
  border-color: #333;
  cursor: default;
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
`;
