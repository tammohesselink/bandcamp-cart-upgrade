# Bandcamp Cart Player

A Chrome extension that embeds a persistent playlist player into your Bandcamp cart and label pages.

## Features

- **Cart player** — plays all tracks from your Bandcamp cart in a persistent bottom bar
- **Label discography player** — on a label's `/music` page, loads and plays the full discography
- **Play buttons** — injects ▶ buttons on each cart item and discography grid item
- **Cart management** — add/remove releases from your cart directly in the player
- **Caching** — track metadata is cached for 1 hour to avoid redundant fetches

## Development

```sh
npm install       # install dependencies
make dev          # build and watch for changes
make build        # one-off build
make test         # run tests
make lint         # lint
make typecheck    # type-check
make zip          # build and package as bandcamp-cart-player.zip
```

Built output goes to `dist/`. To load the extension in Chrome: open `chrome://extensions`, enable Developer Mode, click "Load unpacked", and select the `dist/` folder.

## Stack

- TypeScript + esbuild
- Manifest V3 Chrome extension
- Vitest for tests
