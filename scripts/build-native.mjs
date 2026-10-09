import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

await new Promise((resolve, reject) => {
  const child = spawn(cargo, ['build', '-p', 'aacpipe-win32-native'], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin')};${process.env.PATH ?? ''}`,
    },
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) {
      resolve();
    } else {
      reject(new Error(`cargo build exited with code ${String(code)}`));
    }
  });
});

const outputDirectory = path.join(root, 'apps', 'publisher', 'native');
await mkdir(outputDirectory, { recursive: true });
await copyFile(
  path.join(root, 'target', 'debug', 'aacpipe_win32_native.dll'),
  path.join(outputDirectory, 'aacpipe_win32_native.node'),
);
