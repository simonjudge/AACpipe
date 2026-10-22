import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.platform, 'win32', 'Packaged smoke test requires Windows');
const running = execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', '@(Get-Process -Name AACpipe -ErrorAction SilentlyContinue).Count'],
  { encoding: 'utf8' },
).trim();
assert.equal(running, '0', 'Quit AACpipe before running the isolated packaged smoke test');
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const address = listener.address();
assert(address !== null && typeof address !== 'string');
const port = address.port;
await new Promise((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
);
const directory = await mkdtemp(path.join(os.tmpdir(), 'aacpipe-package-'));
const env = { ...process.env, AACPIPE_PORT: String(port), AACPIPE_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = path.join(root, 'release', 'win-unpacked', 'AACpipe.exe');
const base = `http://127.0.0.1:${String(port)}`;
let app;
let receiver;

async function bridge(...args) {
  const child = spawn(path.join(root, 'release', 'win-unpacked', 'aacpipe-bridge.exe'), args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Never print stdout/stderr: future error text could include private input.
  child.stdout.resume();
  child.stderr.resume();
  const [code] = await once(child, 'exit');
  return code;
}

async function launch() {
  app = await electron.launch({ executablePath, args: ['--host'], env, timeout: 30000 });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'AACpipe partner pairing', exact: true }).waitFor();
  return page;
}

try {
  let page = await launch();
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  assert((await page.textContent('body')).includes(version));
  assert.equal(
    (await fetch(`${base}/manage`)).status,
    403,
    'Other local accounts must not get management access',
  );
  await page
    .getByRole('heading', { name: 'Recommended: stable .local address', exact: true })
    .waitFor({ timeout: 15000 });
  const stable = await readFile(path.join(directory, 'discovery.json'), 'utf8');
  const fallback = page.locator('details.fallbacks').first();
  assert.equal(await fallback.getAttribute('open'), null);
  await fallback.locator('summary').click();
  assert((await fallback.textContent()).includes('IP-address fallback'));
  await page.locator('.pairing-option').first().getByRole('button', { name: 'Copy link' }).click();
  await page.getByRole('status').filter({ hasText: 'Pairing link copied' }).waitFor();
  const link = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert(link.includes('.local:') && link.includes('#p:'));
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await page.getByText('Diagnostics (safe to review and share)', { exact: true }).click();
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  const diagnostics = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert(diagnostics.includes('Version:'));
  assert(!diagnostics.includes('#p:') && !diagnostics.includes('aacpipe_management='));
  await app.evaluate(({ clipboard }) => clipboard.clear());
  const localLink = link.replace(/^http:\/\/[^:]+:/u, 'http://127.0.0.1:');
  const receiverCreated = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }) => {
    const partner = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: 'aacpipe-smoke-receiver',
        sandbox: true,
        nodeIntegration: false,
      },
    });
    void partner.loadURL('about:blank');
  });
  receiver = await receiverCreated;
  await receiver.goto(localLink);
  await receiver.getByText('Connected', { exact: true }).waitFor();
  const example = "I'd like a cup of tea, please.";
  assert.equal(await bridge('--sentence', '--text', example), 0);
  await receiver.getByLabel('AAC message', { exact: true }).filter({ hasText: example }).waitFor();
  const managementWindow = await app.browserWindow(page);
  assert.equal(
    await managementWindow.evaluate((window) => window.isVisible()),
    false,
    'Content commands must hide the management window',
  );
  if (process.argv.includes('--screenshots')) {
    await mkdir(path.join(root, 'docs', 'images'), { recursive: true });
    await receiver.setViewportSize({ width: 900, height: 600 });
    await receiver.screenshot({ path: path.join(root, 'docs', 'images', 'partner-screen.png') });
  }
  assert.equal(await bridge('--clear'), 0);
  await receiver.waitForFunction(
    () => document.querySelector('[aria-label="AAC message"]')?.textContent === '',
  );
  assert.equal(await bridge('--show'), 0);
  const windowState = await managementWindow.evaluate((window) => window.isVisible());
  assert.equal(windowState, true);
  assert.equal(await bridge('--pair', '--persistent', '--label', 'Smoke partner', '--show'), 0);
  await page.getByRole('heading', { name: 'Smoke partner Permanent' }).waitFor();
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Smoke partner Permanent' }) });
  await section.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('heading', { name: 'Revoke “Smoke partner”?' }).waitFor();
  await page.getByRole('button', { name: 'Revoke “Smoke partner”' }).click();
  await page.getByRole('heading', { name: 'AACpipe partner pairing', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Smoke partner Permanent' }).count(), 0);
  await receiver.close();
  await app.close();
  app = undefined;
  page = await launch();
  await page
    .getByRole('heading', { name: 'Recommended: stable .local address', exact: true })
    .waitFor({ timeout: 15000 });
  assert.equal(await readFile(path.join(directory, 'discovery.json'), 'utf8'), stable);
  const cookies = await page.context().cookies(`${base}/manage`);
  const auth = cookies.find((cookie) => cookie.name === 'aacpipe_management');
  assert(auth?.httpOnly);
  const token = await page.locator('input[name="token"]').first().inputValue();
  const denied = await fetch(`${base}/manage/one-time`, {
    method: 'POST',
    headers: {
      Cookie: `aacpipe_management=${auth.value}`,
      Origin: 'http://foreign.invalid',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token }),
  });
  assert.equal(denied.status, 403);
  console.log(
    'Packaged preview smoke: management isolation, QR fallbacks, clipboard, message/clear, show, revoke and restart PASS',
  );
} finally {
  await receiver?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
