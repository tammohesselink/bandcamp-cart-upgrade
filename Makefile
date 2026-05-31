.PHONY: install dev build lint typecheck test zip clean

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

typecheck:
	npx tsc --noEmit

test:
	npx vitest run

zip: build
	@rm -f bandcamp-cart-player.zip
	cd dist && zip -r ../bandcamp-cart-player.zip .
	@echo "Created bandcamp-cart-player.zip"

clean:
	rm -rf dist bandcamp-cart-player.zip
