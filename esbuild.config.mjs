import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

const watch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });
copyFileSync('manifest.json', 'dist/manifest.json');

const sharedOptions = {
  bundle: true,
  format: 'iife',
  target: 'es2022',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  // Strip all console/debugger output from production bundles; keep it during dev watch.
  drop: watch ? [] : ['console', 'debugger'],
};

const entries = [
  { entryPoints: ['src/content.ts'], outfile: 'dist/content.js' },
  { entryPoints: ['src/background.ts'], outfile: 'dist/background.js' },
];

if (watch) {
  const ctxs = await Promise.all(
    entries.map((e) => esbuild.context({ ...sharedOptions, ...e }))
  );
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
  console.log('[bcp] Watching… load dist/ as unpacked extension in Chrome or Firefox');
} else {
  await Promise.all(entries.map((e) => esbuild.build({ ...sharedOptions, ...e })));
  console.log('[bcp] Build complete → dist/');
}
