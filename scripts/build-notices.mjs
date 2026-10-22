import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = new Map();
for (const name of ['publisher', 'subscriber']) {
  const metadata = JSON.parse(
    await readFile(path.join(root, 'dist', `${name}-metafile.json`), 'utf8'),
  );
  for (const input of Object.keys(metadata.inputs)) {
    if (!input.includes('node_modules')) continue;
    let directory = path.dirname(path.resolve(root, input));
    let info;
    while (true) {
      if (existsSync(path.join(directory, 'package.json'))) {
        info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (info.name && info.version) break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`No package metadata for ${input}`);
      directory = parent;
    }
    packages.set(`npm ${info.name}@${info.version}`, { directory, licence: info.license });
  }
}

const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const cargoMetadata = JSON.parse(
  execFileSync(cargo, ['metadata', '--format-version', '1', '--locked'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  }),
);
for (const pkg of cargoMetadata.packages) {
  if (pkg.name.startsWith('aacpipe-')) continue;
  packages.set(`Rust ${pkg.name}@${pkg.version}`, {
    directory: path.dirname(pkg.manifest_path),
    licence: pkg.license,
    repository: pkg.repository,
  });
}

const sections = [
  'AACpipe third-party notices',
  'Generated from actual JavaScript bundle inputs and the locked Rust dependency graph.',
  'Rust build-time dependencies are included conservatively. Electron ships separate Electron and Chromium notices.',
  'AACpipe source and original artwork are MIT licensed; see LICENSE.',
];
for (const [name, { directory, licence, repository }] of [...packages].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const files = (await readdir(directory)).filter((file) =>
    /^(licen[cs]e|copying|notice)([.-]|$)/iu.test(file),
  );
  sections.push(`\n${'='.repeat(72)}\n${name}\nDeclared licence: ${licence ?? 'see licence text'}`);
  if (files.length === 0) {
    if (repository !== 'https://github.com/napi-rs/napi-rs' || licence !== 'MIT') {
      throw new Error(`No licence text found for ${name}; review before distributing`);
    }
    sections.push(
      'Upstream LICENSE, verified at napi-rs/napi-rs commit 8bab46ee5dfd48a7b51e8bad3d09aed315ada4df (omitted from crate archives):',
      await readFile(path.join(root, 'build', 'licenses', 'napi-rs-LICENSE.txt'), 'utf8'),
    );
  }
  for (const file of files.sort()) {
    sections.push(`\n--- ${file} ---\n${await readFile(path.join(directory, file), 'utf8')}`);
  }
}
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist', 'THIRD-PARTY-NOTICES.txt'), `${sections.join('\n')}\n`);
console.log(`Third-party notices generated for ${String(packages.size)} dependency versions.`);
