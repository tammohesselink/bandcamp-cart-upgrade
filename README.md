# Bandcamp Cart Player

A Chrome extension that embeds a persistent playlist player into your Bandcamp cart and label pages.

## Features

- **Cart player** — plays all tracks from your Bandcamp cart in a persistent bottom bar, laid out like the player docked at the bottom of a Bandcamp collection
- **Dark mode** — turn on "Dark mode for the player" in the extension popup to give the player a dark theme (the rest of the Bandcamp page is left as it is)
- **Label discography player** — on a label's `/music` page, loads and plays the full discography
- **Play buttons** — injects ▶ buttons on each cart item and discography grid item
- **Reverse order** — the ⇅ Reverse playlist order button at the right of the player plays the releases last to first (newest added first in the cart, oldest first for a label discography); tracks within a release keep their order, and the choice is remembered per playlist
- **Cart management** — add/remove releases from your cart directly in the player
- **Named carts** — on the player's Cart tab, "Add to named cart" files the playing release into one or more named carts (or a new one); "Checkout a cart" below Bandcamp's cart then checks out just one named cart in a private window
- **Cart history export/import** — move your cart history to another browser or laptop: turn on "Show advanced functionality" in the extension popup, click Export, then Import the JSON file there (imported snapshots are merged with the existing history)
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

The extension logs nothing to the browser console by default. To see its `[bcp]` logs, turn on "Show advanced functionality" and then "Debug logging in the browser console" in the extension popup.

## Releasing

Bump `version` in `manifest.json` in a PR. When it merges, the Publish workflow builds the zip, uploads it to the Chrome Web Store, submits it for review and tags the commit `v<version>`. The new version goes live once Google approves it.

One-time setup for the workflow:

1. In the Google Cloud Console, create a project, enable the Chrome Web Store API, create a service account and download a JSON key for it.
2. In the Chrome Web Store Developer Dashboard, add the service account's email under **Account**.
3. In the GitHub repo settings, add the JSON key as the secret `CHROME_WEB_STORE_SERVICE_ACCOUNT_KEY`, and add the variables `CHROME_WEB_STORE_PUBLISHER_ID` (from **Publisher > Settings** in the dashboard) and `CHROME_WEB_STORE_ITEM_ID` (the extension's ID).

## Stack

- TypeScript + esbuild
- Manifest V3 Chrome extension
- Vitest for tests
