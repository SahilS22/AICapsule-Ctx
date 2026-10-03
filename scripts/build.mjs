// Build pipeline:
//  1. Vite builds the React pages (popup.html, options.html) and copies public/*
//     (manifest.json, icons) into dist/.
//  2. esbuild bundles the content script and background service worker as
//     self-contained IIFE files (no code splitting allowed there).
import { build as viteBuild } from 'vite';
import * as esbuild from 'esbuild';

await viteBuild();

const scriptBuilds = [
  ['src/content/content.ts', 'dist/content.js'],
  ['src/background/background.ts', 'dist/background.js']
];

for (const [entry, outfile] of scriptBuilds) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    platform: 'browser',
    loader: { '.css': 'text' },
    logLevel: 'info'
  });
}

console.log('\n✔ Extension built into dist/ — load it via chrome://extensions → Load unpacked');
