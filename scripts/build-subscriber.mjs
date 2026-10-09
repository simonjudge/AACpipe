import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'apps', 'subscriber', 'dist');
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [path.join(root, 'apps', 'subscriber', 'src', 'browser.ts')],
  outfile: path.join(outputDirectory, 'subscriber.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome109', 'safari16'],
  sourcemap: true,
  minify: false,
  legalComments: 'none',
});
