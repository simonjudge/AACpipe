import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const cargoBin = path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin');

const child = spawn(cargo, ['build', '--release', '-p', 'aacpipe-bridge'], {
  cwd: root,
  env: {
    ...process.env,
    PATH: `${cargoBin}${path.delimiter}${process.env.PATH ?? ''}`,
  },
  stdio: 'inherit',
});
child.once('error', (error) => {
  console.error(`Could not start Cargo: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (code === 0) return;
  if (code === null) {
    console.error(`Cargo exited after signal ${signal ?? 'unknown'}`);
  }
  process.exitCode = code ?? 1;
});
