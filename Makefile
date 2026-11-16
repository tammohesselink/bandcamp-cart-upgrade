.PHONY: install dev build lint lint-firefox typecheck test zip source-zip run-firefox publish-firefox clean

install:
	npm install

dev:
	@mkdir -p dist
	@cp manifest.json dist/manifest.json
	node esbuild.config.mjs --watch

build:
	@mkdir -p dist
	@cp manifest.json dist/manifest.json
	node esbuild.config.mjs

lint:
	npx eslint src

# Checks the built extension against addons.mozilla.org's rules. Fails on errors only:
# the remaining warnings are expected (e.g. Firefox ignoring "incognito": "split").
lint-firefox: build
	npx web-ext lint --source-dir dist

typecheck:
	npx tsc --noEmit

test:
	npx vitest run

zip: build
	@rm -f bandcamp-cart-player.zip
	cd dist && zip -r ../bandcamp-cart-player.zip .
	@echo "Created bandcamp-cart-player.zip"

# The bundles are minified, so addons.mozilla.org needs the source to review each version.
source-zip:
	@rm -f bandcamp-cart-player-source.zip
	git archive --format=zip HEAD -o bandcamp-cart-player-source.zip
	@echo "Created bandcamp-cart-player-source.zip"

# Opens a temporary Firefox profile with the built extension loaded.
run-firefox: build
	npx web-ext run --source-dir dist --start-url https://bandcamp.com

# Uploads the built extension to addons.mozilla.org and submits it for review, without
# waiting for the review. Needs WEB_EXT_API_KEY and WEB_EXT_API_SECRET (the JWT issuer
# and secret from addons.mozilla.org/developers/addon/api/key/). The source goes along
# for the reviewers; amo-metadata.json fills in the listing on the first upload.
publish-firefox: build source-zip
	npx web-ext sign --source-dir dist --channel listed \
		--amo-metadata amo-metadata.json \
		--upload-source-code bandcamp-cart-player-source.zip \
		--approval-timeout 0

clean:
	rm -rf web-ext-artifacts dist bandcamp-cart-player.zip bandcamp-cart-player-source.zip
