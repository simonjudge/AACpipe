import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'dist', 'apps', 'publisher', 'src', 'main');

await mkdir(outputDirectory, { recursive: true });
const result = await build({
  entryPoints: [path.join(root, 'apps', 'publisher', 'src', 'main', 'electron-main.ts')],
  outfile: path.join(outputDirectory, 'electron-main.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
});
await writeFile(
  path.join(root, 'dist', 'publisher-metafile.json'),
  JSON.stringify(result.metafile),
);
