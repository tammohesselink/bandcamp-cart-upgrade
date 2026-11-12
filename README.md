# Bandcamp Cart Player

A Chrome extension that embeds a persistent playlist player into your Bandcamp cart and label pages.

## Features

- **Cart player** — plays all tracks from your Bandcamp cart in a persistent bottom bar, laid out like the player docked at the bottom of a Bandcamp collection
- **Dark mode** — turn on "Dark mode for the player" in the extension popup to give the player a dark theme (the rest of the Bandcamp page is left as it is)
- **Label discography player** — on a label's `/music` page, loads and plays the full discography
- **Collection player** — on a fan's collection page (`bandcamp.com/<username>`), the player replaces Bandcamp's own one: clicking an item's artwork plays it, a track bought on its own plays just that track, and the Collection playlist holds the items shown on the page. Items Bandcamp shows after you click "view all" or scroll further join it as they appear. The wishlist (`bandcamp.com/<username>/wishlist`, or its tab on the collection page) plays the same way, as a Wishlist playlist. On your own wishlist, the player offers to remove the playing item from it
- **Feed player** — on your feed (`bandcamp.com/<username>/feed`), the player replaces Bandcamp's own one in the same way: the Feed playlist holds the releases in the Fan Activity stories, and the New releases playlist holds the "New Releases from artists you follow" sidebar. Clicking a release's artwork plays it, and older stories join the Feed playlist as Bandcamp shows them
- **Play buttons** — injects ▶ buttons on each cart item and discography grid item
- **Reverse order** — the ⇅ button (Reverse playlist order) at the right of the player plays the releases last to first (newest added first in the cart, oldest first for a label discography); tracks within a release keep their order, and the choice is remembered per playlist
- **Tempo analysis (BPM)** — turn on "Detect track BPMs" in the extension popup (it asks to read Bandcamp's audio streams on bcbits.com). The player then shows a BPM button next to the tempo slider with the BPM the playing track is heard at, and each track's BPM in the queue. The button opens a tempo panel:
  - type the BPM you want it played at and the slider moves to match (widening its range when needed)
  - fix a detection that is off by an octave with ÷2 / ×2, type the BPM, or tap along
  - "Keep this BPM" makes every next track play at the same BPM, at half or double time when that is the smaller change

  Only the playing track and the next few in the queue are analysed: the first ~2.5 minutes of each are downloaded and analysed in the browser. BPMs are remembered per track, and the ones you set are never overwritten by automatic detection. With the setting off, none of this shows and nothing is downloaded
- **Cart management** — add/remove releases from your cart directly in the player. On a release page, the "buy track" link a track shows on hover becomes "+ track", which adds the track to your cart like "+ Track" in the player; it reads "already in cart", greyed out, while the track or its release is in your cart
- **Named carts** — for a release in your cart, "Add to named cart" in the player files it into one or more named carts (or a new one); to file several at once, tick them in Bandcamp's cart and click "Add selected to named cart". "Checkout a cart" below Bandcamp's cart then checks out just one named cart in a private window. Turn off "Enable named carts" in the extension popup to hide all of this; your named carts are kept for when you turn it back on
- **Cart history export/import** — move your cart history to another browser or laptop: turn on "Show advanced functionality" in the extension popup, click Export, then Import the JSON file there (imported snapshots are merged with the existing history)
- **Purchase export** — on your purchases page (`bandcamp.com/<username>/purchases`), click "Load purchases" to see how much you've spent on Bandcamp per year (this year by default), converted into one currency, and export the purchases as a CSV. Each purchase is converted at the European Central Bank rate of its payment date, from [frankfurter.dev](https://frankfurter.dev); only a date range is sent there, and the rates are cached. This feature is taken from the purchase export in [Bandcamp Tempo Adjust](https://github.com/azarbayejani/bandcamp-tempo-adjust) and included here so you don't need to install several Bandcamp extensions that do the same things
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

## License

MIT, see [LICENSE](LICENSE). The purchase export comes from Bandcamp Tempo Adjust, also MIT licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
