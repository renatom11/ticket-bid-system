// Builds the standalone single-file demo from the real engine sources, so
// web-demo never drifts from src/. Emits:
//   web-demo/index.html    — full document (GitHub Pages)
//   web-demo/fragment.html — same content without the document wrapper
//                            (Claude Artifact publishing)
// Usage: node web-demo/build.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// Strip ES module syntax so the sources run as one inline script.
const strip = (src) =>
  src
    .split('\n')
    .filter((line) => !/^import /.test(line))
    .map((line) => line.replace(/^export (class|const|function)/, '$1'))
    .join('\n');

const engine = [
  '/* ---- built from src/ by web-demo/build.mjs — edit the sources, not this file ---- */',
  strip(read('src/venue.js')),
  strip(read('src/market.js')),
  strip(read('src/engine.js')),
  strip(read('src/bots.js')),
].join('\n\n');

const template = read('web-demo/template.html');
if (!template.includes('/*__ENGINE__*/')) throw new Error('template is missing the /*__ENGINE__*/ token');
// The engine lives in its own <script id="engine-code"> so the page can read
// its text back and boot the same code inside a Web Worker.
const fragment = template.replace(
  /<script>\s*\/\*__ENGINE__\*\//,
  '<script id="engine-code">\n' + engine + '\n</script>\n<script>'
);
if (fragment.includes('/*__ENGINE__*/')) throw new Error('engine injection failed');

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A ticket drop as an exactly-cleared auction — join, bid against a behavioral crowd, and watch precise per-show prices form.">
<meta property="og:title" content="Drop Clock">
<meta property="og:description" content="Ticket drops as an exact clearing auction: everyone who can afford a seat they accept is guaranteed one, at a precisely computed price.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%9F%EF%B8%8F%3C/text%3E%3C/svg%3E">
</head>
`;

writeFileSync(path.join(root, 'web-demo/fragment.html'), fragment);
writeFileSync(path.join(root, 'web-demo/index.html'), head + fragment + '\n</html>\n');
console.log('built web-demo/index.html and web-demo/fragment.html');
