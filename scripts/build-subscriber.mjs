import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'apps', 'subscriber', 'dist');
await mkdir(outputDirectory, { recursive: true });

const result = await build({
  entryPoints: {
    subscriber: path.join(root, 'apps', 'subscriber', 'src', 'browser.ts'),
    manage: path.join(root, 'apps', 'subscriber', 'src', 'manage.ts'),
  },
  outdir: outputDirectory,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome109', 'safari16'],
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  metafile: true,
});
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(
  path.join(root, 'dist', 'subscriber-metafile.json'),
  JSON.stringify(result.metafile),
);
