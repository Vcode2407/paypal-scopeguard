import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPayPalCredentials, PayPalCredentialStore } from '../src/paypal-credentials.js';

// Storage tests use synthetic keys and temporary files only. No provider,
// OAuth, application credential file or running ScopeGuard process is used.
const KEYS = { clientId: 'synthetic-paypal-client-id', secret: 'synthetic-paypal-secret' };
const runFile = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'scopeguard-paypal-test-'));
  t.after(async () => {
    assert.ok(root.startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  return { root, store: new PayPalCredentialStore(join(root, 'paypal-sandbox')) };
}
function safeError(error) {
  assert.equal(error.status, 503);
  assert.doesNotMatch(error.message + JSON.stringify(error), /synthetic-paypal|access_token|plaintext-marker/);
  return true;
}
async function exposeWindows(path, directory) {
  const script = `$ErrorActionPreference='Stop'; $p=$env:SCOPEGUARD_TEST_PATH; $everyone=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); if($env:SCOPEGUARD_TEST_DIRECTORY -eq 'yes'){$acl=[System.IO.Directory]::GetAccessControl($p)}else{$acl=[System.IO.File]::GetAccessControl($p)}; $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($everyone,'Read',[System.Security.AccessControl.AccessControlType]::Allow))); if($env:SCOPEGUARD_TEST_DIRECTORY -eq 'yes'){[System.IO.Directory]::SetAccessControl($p,$acl)}else{[System.IO.File]::SetAccessControl($p,$acl)}`;
  await runFile(resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { SystemRoot: process.env.SystemRoot, SCOPEGUARD_TEST_PATH: path, SCOPEGUARD_TEST_DIRECTORY: directory ? 'yes' : 'no' } });
}

test('complete PayPal environment credentials take precedence without reading protected storage', async () => {
  let reads = 0;
  const credentials = await loadPayPalCredentials({ env: { PAYPAL_SANDBOX_CLIENT_ID: KEYS.clientId, PAYPAL_SANDBOX_SECRET: KEYS.secret }, store: { read() { reads++; throw Error('must not read'); } } });
  assert.deepEqual(credentials, KEYS); assert.equal(reads, 0);
});

test('partial, empty or malformed PayPal environment configuration never falls back to disk', async () => {
  let reads = 0; const store = { read() { reads++; return KEYS; } };
  for (const env of [
    { PAYPAL_SANDBOX_CLIENT_ID: KEYS.clientId }, { PAYPAL_SANDBOX_SECRET: KEYS.secret },
    { PAYPAL_SANDBOX_CLIENT_ID: '', PAYPAL_SANDBOX_SECRET: '' },
    { PAYPAL_SANDBOX_CLIENT_ID: KEYS.clientId, PAYPAL_SANDBOX_SECRET: '' },
    { PAYPAL_SANDBOX_CLIENT_ID: 'bad:client', PAYPAL_SANDBOX_SECRET: KEYS.secret },
  ]) await assert.rejects(loadPayPalCredentials({ env, store }), safeError);
  assert.equal(reads, 0);
});

test('absent PayPal configuration is optional, but unsafe storage failures propagate', async t => {
  const { store } = await fixture(t);
  assert.equal(await loadPayPalCredentials({ env: {}, store }), null);
  const error = Error('synthetic failure');
  await assert.rejects(loadPayPalCredentials({ env: {}, store: { read() { throw error; } } }), error);
});

test('synthetic PayPal credentials round-trip through actual platform protection and atomic replacement', async t => {
  const { store } = await fixture(t);
  await store.write(KEYS);
  const text = await readFile(store.file, 'utf8'); const record = JSON.parse(text);
  if (process.platform === 'win32') {
    assert.equal(record.protection, 'windows-dpapi-current-user');
    assert.doesNotMatch(text, /synthetic-paypal-client-id|synthetic-paypal-secret/);
  } else {
    assert.equal(record.protection, 'posix-owner-only');
    assert.equal((await lstat(store.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(store.file)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await loadPayPalCredentials({ env: {}, store }), KEYS);
  const replacement = { ...KEYS, secret: 'synthetic-paypal-replacement-secret' };
  await store.write(replacement); assert.deepEqual(await store.read(), replacement);
  await assert.rejects(lstat(join(store.directory, 'credentials.lock')), { code: 'ENOENT' });
});

test('changed ciphertext or a changed inner checksum cannot activate credentials', async t => {
  const { store } = await fixture(t); await store.write(KEYS);
  const record = JSON.parse(await readFile(store.file, 'utf8'));
  if (process.platform === 'win32') {
    const bytes = Buffer.from(record.payload, 'base64'); bytes[Math.floor(bytes.length / 2)] ^= 1; record.payload = bytes.toString('base64');
  } else {
    const envelope = JSON.parse(record.payload); envelope.credentials.secret = 'plaintext-marker'; record.payload = JSON.stringify(envelope);
  }
  await writeFile(store.file, JSON.stringify(record));
  await assert.rejects(store.read(), safeError);
});

test('wrong platform/schema and oversized stored data fail without exposing content', async t => {
  const { store } = await fixture(t); await store.write(KEYS);
  const original = await readFile(store.file, 'utf8');
  for (const content of ['{"version":1,"payload":"plaintext-marker"}', JSON.stringify({ version: 1, protection: 'other', payload: 'plaintext-marker' }), 'x'.repeat(16001)]) {
    await writeFile(store.file, content); await assert.rejects(store.read(), safeError);
  }
  await writeFile(store.file, original); assert.deepEqual(await store.read(), KEYS);
});

test('PayPal storage rejects hard-linked files before read or replacement', async t => {
  const { root, store } = await fixture(t); await store.write(KEYS);
  const before = await readFile(store.file); const alias = join(root, 'outside-alias.json');
  await link(store.file, alias);
  await assert.rejects(store.read(), safeError);
  await assert.rejects(store.write({ ...KEYS, secret: 'synthetic-paypal-replacement-secret' }), safeError);
  assert.deepEqual(await readFile(alias), before);
});

test('PayPal setup rejects an ancestor junction or symlink before creating any credential files', async t => {
  const { root } = await fixture(t); const target = join(root, 'redirect-target'); const redirect = join(root, 'redirect');
  await mkdir(target);
  await symlink(target, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  const store = new PayPalCredentialStore(join(redirect, 'paypal-sandbox'));
  await assert.rejects(store.write(KEYS), safeError);
  await assert.rejects(lstat(join(target, 'paypal-sandbox')), { code: 'ENOENT' });
});

test('existing unsafe file permissions are rejected rather than repaired', async t => {
  const { store } = await fixture(t); await store.write(KEYS); const original = await readFile(store.file);
  if (process.platform === 'win32') await exposeWindows(store.file, false); else await chmod(store.file, 0o644);
  await assert.rejects(store.read(), safeError); await assert.rejects(store.write(KEYS), safeError);
  assert.deepEqual(await readFile(store.file), original);
  if (process.platform !== 'win32') assert.equal((await lstat(store.file)).mode & 0o777, 0o644);
});

test('existing unsafe directory permissions are rejected before changing its files', async t => {
  const { store } = await fixture(t); await store.write(KEYS); const original = await readFile(store.file);
  if (process.platform === 'win32') await exposeWindows(store.directory, true); else await chmod(store.directory, 0o755);
  await assert.rejects(store.read(), safeError); await assert.rejects(store.write(KEYS), safeError);
  assert.deepEqual(await readFile(store.file), original);
});

test('an existing importer lock blocks replacement and preserves the prior valid record', async t => {
  const { store } = await fixture(t); await store.write(KEYS); const original = await readFile(store.file);
  const lock = join(store.directory, 'credentials.lock'); await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  await assert.rejects(store.write({ ...KEYS, secret: 'synthetic-paypal-replacement-secret' }), safeError);
  assert.deepEqual(await readFile(store.file), original); assert.equal((await lstat(lock)).isFile(), true);
  await rm(lock); assert.deepEqual(await store.read(), KEYS);
});

function importerProcess({ args, input = Buffer.alloc(0), cwd, guard }) {
  return new Promise((resolveResult, reject) => {
    // Do not inherit account/provider secrets or user NODE_OPTIONS into fixtures.
    const env = {};
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
    const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let finished = false;
    const timer = setTimeout(() => { child.kill(); finish(Error('Fixture process exceeded its deadline.')); }, 5000);
    const finish = (error, code) => {
      if (finished) return; finished = true; clearTimeout(timer);
      error ? reject(error) : resolveResult({ code, stdout, stderr });
    };
    child.stdout.on('data', data => { stdout += data.toString('utf8'); });
    child.stderr.on('data', data => { stderr += data.toString('utf8'); });
    child.on('error', error => finish(error)); child.on('close', code => finish(null, code));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

test('credential importer rejects invalid process input without storage access or secret-marker output', async t => {
  const { root } = await fixture(t); const guard = join(root, 'no-storage-access.mjs');
  const storageMarker = 'UNEXPECTED_CREDENTIAL_STORAGE_OPERATION'; const secretMarker = 'synthetic-secret-redaction-marker';
  // Preload replaces the exact filesystem functions used by the store before
  // its named imports are created. Any credential-store read/check/write emits
  // a fixed marker and throws before accessing a path. Loader internals are not
  // patched; source modules may still load normally. All cases fail validation
  // before PayPalCredentialStore is instantiated.
  await writeFile(guard, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; for(const name of ['lstat','mkdir','open','rename','unlink']) fs[name]=async()=>{process.stderr.write('${storageMarker}\\n'); throw Error('Storage access blocked by fixture.');}; syncBuiltinESMExports();`);
  const probe = await importerProcess({ cwd: root, guard, args: ['--input-type=module', '--eval', "import {lstat} from 'node:fs/promises'; await lstat('synthetic-path-that-must-never-be-read');"] });
  assert.notEqual(probe.code, 0); assert.match(probe.stderr, new RegExp(storageMarker), 'The guard must intercept named filesystem imports without accessing the probe path');
  const entry = fileURLToPath(new URL('../scripts/configure-paypal.js', import.meta.url));
  const malformedJson = Buffer.from(`{"secret":"${secretMarker}",`);
  const malformedUtf8 = Buffer.concat([Buffer.from(`{"secret":"${secretMarker}`), Buffer.from([0xff]), Buffer.from('"}')]);
  for (const [label, args, input] of [
    ['oversized stdin', ['--stdin'], Buffer.from(`${secretMarker}${'x'.repeat(1700)}`)],
    ['malformed UTF-8', ['--stdin'], malformedUtf8],
    ['malformed JSON', ['--stdin'], malformedJson],
    ['unsupported arguments', [`--unsupported-${secretMarker}`], malformedJson],
  ]) {
    const result = await importerProcess({ cwd: root, guard, args: [entry, ...args], input });
    assert.equal(result.code, 1, label);
    assert.equal(result.stdout, '', label);
    assert.match(result.stderr, /^PayPal setup did not finish\./, label);
    assert.ok(!result.stdout.includes(secretMarker) && !result.stderr.includes(secretMarker), `${label}: entered marker must be redacted`);
    assert.ok(!result.stderr.includes(storageMarker), `${label}: no credential-store access is allowed`);
    assert.doesNotMatch(result.stderr, /SyntaxError|TypeError|at file:/, `${label}: raw errors and stacks must be excluded`);
  }
});
