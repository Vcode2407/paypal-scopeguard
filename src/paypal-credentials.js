import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Problem } from './domain.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PAYPAL_CREDENTIAL_DIRECTORY = resolve(ROOT, 'data', 'paypal-sandbox');
const MAX_BYTES = 16000;
const PURPOSE = 'ScopeGuard PayPal sandbox credentials v1';
const failure = () => new Problem('Protected PayPal sandbox credentials are unavailable or invalid. Configure them again using the local setup command.', 503);
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
function validate(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)
    || Object.keys(credentials).sort().join(',') !== 'clientId,secret'
    || !validKey(credentials.clientId) || !validKey(credentials.secret)) throw failure();
  return { clientId: credentials.clientId, secret: credentials.secret };
}
const checksum = credentials => createHash('sha256').update(JSON.stringify(credentials)).digest('hex');
function encode(credentials) {
  const normalized = validate(credentials);
  return JSON.stringify({ version: 1, purpose: PURPOSE, credentials: normalized, checksum: checksum(normalized) });
}
function decode(text) {
  try {
    const record = JSON.parse(text);
    if (Object.keys(record).sort().join(',') !== 'checksum,credentials,purpose,version'
      || record.version !== 1 || record.purpose !== PURPOSE || !/^[a-f0-9]{64}$/.test(record.checksum)) throw failure();
    const credentials = validate(record.credentials);
    if (!timingSafeEqual(Buffer.from(record.checksum), Buffer.from(checksum(credentials)))) throw failure();
    return credentials;
  } catch { throw failure(); }
}

// Static code and non-secret paths/actions only enter argv/env. Credential
// bytes travel through private child pipes and are never diagnostic output.
const WINDOWS_SCRIPT = `
$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Security
  $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid=$identity.User
  $system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
  $allow=[System.Security.AccessControl.AccessControlType]::Allow
  function Check-OrdinaryPath($p) {
    for($current=[System.IO.Path]::GetFullPath($p);$current;$current=[System.IO.Path]::GetDirectoryName($current)){
      if(([System.IO.File]::GetAttributes($current) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){throw 'PRIVATE_STORAGE'}
    }
  }
  function Read-PrivateAcl($p,$directory) {
    if($directory){return [System.IO.Directory]::GetAccessControl($p)}
    return [System.IO.File]::GetAccessControl($p)
  }
  function Check-PrivateAcl($p,$directory) {
    Check-OrdinaryPath $p
    $acl=Read-PrivateAcl $p $directory
    if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $acl.AreAccessRulesProtected){throw 'PRIVATE_STORAGE'}
    $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
    $foundUser=$false
    foreach($rule in $rules){
      if($rule.IsInherited -or $rule.AccessControlType -ne $allow -or $rule.IdentityReference.Value -notin @($sid.Value,$system.Value) -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl){throw 'PRIVATE_STORAGE'}
      if($rule.IdentityReference.Value -eq $sid.Value){$foundUser=$true}
    }
    if(-not $foundUser){throw 'PRIVATE_STORAGE'}
  }
  function Set-PrivateAcl($p,$directory) {
    Check-OrdinaryPath $p
    $existing=Read-PrivateAcl $p $directory
    $owner=$existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if($owner -ne $sid.Value){
      $principal=New-Object System.Security.Principal.WindowsPrincipal($identity)
      if($owner -ne 'S-1-5-32-544' -or -not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'PRIVATE_STORAGE'}
      $existing.SetOwner($sid)
      if($directory){[System.IO.Directory]::SetAccessControl($p,$existing)}else{[System.IO.File]::SetAccessControl($p,$existing)}
    }
    if($directory){
      $acl=New-Object System.Security.AccessControl.DirectorySecurity
      $inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
      $prop=[System.Security.AccessControl.PropagationFlags]::None
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,$prop,$allow)))
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system,'FullControl',$inherit,$prop,$allow)))
    }else{
      $acl=New-Object System.Security.AccessControl.FileSecurity
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$allow)))
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system,'FullControl',$allow)))
    }
    $acl.SetAccessRuleProtection($true,$false)
    if($directory){[System.IO.Directory]::SetAccessControl($p,$acl)}else{[System.IO.File]::SetAccessControl($p,$acl)}
    Check-PrivateAcl $p $directory
  }
  switch($env:SCOPEGUARD_PAYPAL_ACTION) {
    'secure' {Set-PrivateAcl $env:SCOPEGUARD_PAYPAL_PATH ($env:SCOPEGUARD_PAYPAL_DIRECTORY -eq 'yes'); [Console]::Write('OK')}
    'check' {Check-PrivateAcl $env:SCOPEGUARD_PAYPAL_PATH ($env:SCOPEGUARD_PAYPAL_DIRECTORY -eq 'yes'); [Console]::Write('OK')}
    'protect' {
      $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())
      $entropy=[Text.Encoding]::UTF8.GetBytes('${PURPOSE}')
      $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::Write([Convert]::ToBase64String($result))
      [Array]::Clear($bytes,0,$bytes.Length)
    }
    'unprotect' {
      $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())
      $entropy=[Text.Encoding]::UTF8.GetBytes('${PURPOSE}')
      $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::Write([Convert]::ToBase64String($result))
      [Array]::Clear($result,0,$result.Length)
    }
    default {throw 'PRIVATE_STORAGE'}
  }
} catch {exit 1}
`;
function windowsOperation(action, { path = '', directory = false, input = '' } = {}) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, { SCOPEGUARD_PAYPAL_ACTION: action, SCOPEGUARD_PAYPAL_PATH: path, SCOPEGUARD_PAYPAL_DIRECTORY: directory ? 'yes' : 'no' });
  const executable = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let settled = false;
    const timer = setTimeout(() => { child.kill(); finish(false); }, 10000);
    const finish = ok => { if (settled) return; settled = true; clearTimeout(timer); ok ? resolveResult(output) : reject(failure()); };
    child.stdout.on('data', bytes => { output += bytes.toString('ascii'); if (output.length > MAX_BYTES) { child.kill(); finish(false); } });
    child.stderr.resume(); // Never copy child diagnostics into application errors.
    child.on('error', () => finish(false)); child.on('close', code => finish(code === 0));
    child.stdin.on('error', () => finish(false)); child.stdin.end(input);
  });
}
const strictBase64 = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_BYTES
  && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;
async function ordinaryAncestors(path, allowMissing = false) {
  for (let current = path; ; current = dirname(current)) {
    try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw failure(); }
    catch (error) { if (!(allowMissing && error.code === 'ENOENT')) throw failure(); }
    if (dirname(current) === current) return;
  }
}
function privateMetadata(info, directory = false) {
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || !directory && info.nlink !== 1) throw failure();
  if (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o777) !== (directory ? 0o700 : 0o600))) throw failure();
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Optional sandbox credentials; loading never authenticates or calls PayPal. */
export class PayPalCredentialStore {
  constructor(directory = PAYPAL_CREDENTIAL_DIRECTORY) {
    this.directory = resolve(directory); this.file = resolve(this.directory, 'credentials.json');
  }
  async checkDirectory() {
    await ordinaryAncestors(this.directory);
    privateMetadata(await lstat(this.directory), true);
    if (process.platform === 'win32' && await windowsOperation('check', { path: this.directory, directory: true }) !== 'OK') throw failure();
  }
  async checkFile(path) {
    const info = await lstat(path); privateMetadata(info);
    if (process.platform === 'win32' && await windowsOperation('check', { path }) !== 'OK') throw failure();
    return info;
  }
  async read() {
    try {
      await ordinaryAncestors(this.directory, true);
      try { await lstat(this.directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      await this.checkDirectory();
      let before; try { before = await this.checkFile(this.file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (before.size > MAX_BYTES) throw failure();
      const handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let text;
      try {
        const opened = await handle.stat(); privateMetadata(opened);
        if (!sameFile(before, opened) || !sameFile(opened, await this.checkFile(this.file))) throw failure();
        const buffer = Buffer.alloc(MAX_BYTES + 1); let bytes = 0;
        while (bytes < buffer.length) { const result = await handle.read(buffer, bytes, buffer.length - bytes, null); if (!result.bytesRead) break; bytes += result.bytesRead; }
        if (bytes > MAX_BYTES || !sameFile(opened, await this.checkFile(this.file))) throw failure();
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
      } finally { await handle.close(); }
      const record = JSON.parse(text);
      if (Object.keys(record).sort().join(',') !== 'payload,protection,version' || record.version !== 1) throw failure();
      if (process.platform === 'win32') {
        if (record.protection !== 'windows-dpapi-current-user' || !strictBase64(record.payload)) throw failure();
        const clear = await windowsOperation('unprotect', { input: record.payload });
        if (!strictBase64(clear)) throw failure();
        return decode(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(clear, 'base64')));
      }
      if (record.protection !== 'posix-owner-only' || typeof record.payload !== 'string') throw failure();
      return decode(record.payload);
    } catch { throw failure(); }
  }
  async write(credentials) {
    const clear = encode(credentials); const temporary = resolve(this.directory, `credentials-${randomUUID()}.tmp`);
    const lockPath = resolve(this.directory, 'credentials.lock'); let lock; let createdTemporary = false;
    try {
      await ordinaryAncestors(this.directory, true);
      const created = await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await ordinaryAncestors(this.directory);
      // Recursive mkdir returns undefined when the directory already existed.
      // Existing exposed directories fail; only new ones receive initial ACLs.
      if (created !== undefined && process.platform === 'win32') await windowsOperation('secure', { path: this.directory, directory: true });
      await this.checkDirectory();
      try { await this.checkFile(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      lock = await open(lockPath, 'wx', 0o600);
      privateMetadata(await lstat(lockPath));
      if (process.platform === 'win32') await windowsOperation('secure', { path: lockPath });
      const payload = process.platform === 'win32' ? await windowsOperation('protect', { input: Buffer.from(clear).toString('base64') }) : clear;
      if (process.platform === 'win32' && !strictBase64(payload)) throw failure();
      const record = JSON.stringify({ version: 1, protection: process.platform === 'win32' ? 'windows-dpapi-current-user' : 'posix-owner-only', payload });
      const handle = await open(temporary, 'wx', 0o600); createdTemporary = true;
      try {
        privateMetadata(await lstat(temporary));
        if (process.platform === 'win32') await windowsOperation('secure', { path: temporary });
        const opened = await handle.stat(); privateMetadata(opened);
        if (!sameFile(opened, await this.checkFile(temporary))) throw failure();
        await handle.writeFile(record); await handle.sync();
      } finally { await handle.close(); }
      await this.checkDirectory();
      try { await this.checkFile(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(temporary, this.file); createdTemporary = false;
      await this.checkFile(this.file);
    } catch { throw failure(); }
    finally {
      if (createdTemporary) await unlink(temporary).catch(() => {});
      if (lock) { await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {}); }
    }
  }
}

export async function loadPayPalCredentials({ env = process.env, store = new PayPalCredentialStore() } = {}) {
  const hasId = Object.hasOwn(env, 'PAYPAL_SANDBOX_CLIENT_ID'); const hasSecret = Object.hasOwn(env, 'PAYPAL_SANDBOX_SECRET');
  if (hasId || hasSecret) {
    if (!hasId || !hasSecret) throw failure();
    return validate({ clientId: env.PAYPAL_SANDBOX_CLIENT_ID, secret: env.PAYPAL_SANDBOX_SECRET });
  }
  return store.read();
}
