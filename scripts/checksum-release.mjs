import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const name = `AACpipe Setup ${version}.exe`;
const hash = createHash('sha256')
  .update(await readFile(new URL(`../release/${name}`, import.meta.url)))
  .digest('hex');
await writeFile(new URL('../release/SHA256SUMS.txt', import.meta.url), `${hash}  ${name}\n`);
console.log(`SHA-256 written for ${name}`);
