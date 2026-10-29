# Bandcamp Cart Player

A Chrome extension that embeds a persistent playlist player into your Bandcamp cart and label pages.

## Features

- **Cart player** — plays all tracks from your Bandcamp cart in a persistent bottom bar, laid out like the player docked at the bottom of a Bandcamp collection, with a volume control that is remembered
- **Label discography player** — on a label's `/music` page, loads and plays the full discography
- **Play buttons** — injects ▶ buttons on each cart item and discography grid item
- **Reverse order** — the ⇅ Reverse playlist order button next to the playlist tabs plays the releases last to first (newest added first in the cart, oldest first for a label discography); tracks within a release keep their order, and the choice is remembered per playlist
- **Cart management** — add/remove releases from your cart directly in the player
- **Cart history export/import** — move your cart history to another browser or laptop: click Export in the extension popup, then Import the JSON file there (imported snapshots are merged with the existing history)
- **Caching** — track details are cached for six months; stream links are refreshed when a track is about to play if they are more than an hour old

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
