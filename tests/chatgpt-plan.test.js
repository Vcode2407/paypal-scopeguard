import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ChatGPTPlanAssistant, ChatGPTPlanConnection, PrivateCredentialStore, SIWC } from '../src/chatgpt-plan.js';
import { SAMPLE, offlineAssess } from '../src/domain.js';

// All provider traffic is intercepted. Only the documented loopback callback is
// actually requested; no OpenAI endpoint, login, account or inference is used.
const NOW = Date.parse('2026-10-10T12:00:00Z');
const MODEL = 'account-test-model';
const CLIENT = 'oaiapp_scopeguard_test';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'scopeguard-test', alg: 'RS256', use: 'sig' };

class MemoryStore {
  constructor(record = null) { this.record = structuredClone(record); this.fail = false; this.writes = 0; }
  async acquire() {}
  async read() { return structuredClone(this.record); }
  async write(record) { if (this.fail) throw new Error('Simulated storage failure'); this.record = structuredClone(record); this.writes++; }
  async close() {}
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function stream({ model = MODEL, terminal = 'response.completed', text = JSON.stringify({ assessments: offlineAssess(SAMPLE) }), truncate = false, oversized = false } = {}) {
  const events = [{ type: 'response.output_text.delta', delta: oversized ? 'x'.repeat(17000) : text }];
  if (!truncate) events.push({ type: terminal, response: { id: 'response-stub', model, status: terminal === 'response.completed' ? 'completed' : 'failed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } });
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
async function identity({ nonce, clientId = CLIENT, subject = 'test-subject', issuer = SIWC.issuer, audience = clientId, expiresAt = NOW / 1000 + 3600, key = privateKey } = {}) {
  return new SignJWT({ nonce, email: 'fictional@example.invalid' }).setProtectedHeader({ alg: 'RS256', kid: 'scopeguard-test' }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt(NOW / 1000).setExpirationTime(expiresAt).sign(key);
}
function provider({ scope = SIWC.scopes, identityChanges = {}, responses = () => stream(), revokeStatus = 200, models = [{ slug: MODEL, display_name: 'Account test model', visibility: 'list' }], refreshHook } = {}) {
  const fixture = { auth: null, calls: [], codeExchanges: 0, refreshes: 0, apiCalls: 0 };
  fixture.fetch = async (url, options = {}) => {
    const endpoint = String(url); fixture.calls.push({ endpoint, options });
    if (endpoint === SIWC.discovery) return json({ issuer: SIWC.issuer, authorization_endpoint: SIWC.authorize, token_endpoint: SIWC.token, jwks_uri: SIWC.jwks, revocation_endpoint: `${SIWC.issuer}/api/accounts/oauth/revoke` });
    if (endpoint === SIWC.jwks) return json({ keys: [jwk] });
    if (endpoint === SIWC.token) {
      const form = new URLSearchParams(options.body);
      assert.equal(options.redirect, 'error');
      assert.equal(form.get('client_id'), CLIENT);
      assert.equal(form.get('resource'), SIWC.resource);
      assert.equal(form.has('client_secret'), false);
      if (form.get('grant_type') === 'refresh_token') {
        fixture.refreshes++; assert.equal(form.has('scope'), false);
        if (refreshHook) await refreshHook(form);
        return json({ access_token: 'stub-access-refreshed', refresh_token: 'stub-refresh-rotated', token_type: 'Bearer', expires_in: 3600, scope });
      }
      fixture.codeExchanges++;
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('redirect_uri'), fixture.auth.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), fixture.auth.searchParams.get('code_challenge'));
      return json({ access_token: 'stub-access-private', refresh_token: 'stub-refresh-private', token_type: 'Bearer', expires_in: 3600, scope, id_token: await identity({ nonce: fixture.auth.searchParams.get('nonce'), ...identityChanges }) });
    }
    if (endpoint === SIWC.models) {
      assert.match(options.headers.Authorization, /^Bearer stub-access-/);
      return json({ models });
    }
    if (endpoint === SIWC.responses) { fixture.apiCalls++; return responses(options); }
    if (endpoint === `${SIWC.issuer}/api/accounts/oauth/revoke`) {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('token_type_hint'), 'refresh_token'); assert.match(form.get('token'), /^stub-refresh-/); assert.equal(form.get('client_id'), CLIENT);
      return new Response('', { status: revokeStatus });
    }
    assert.fail(`Unexpected provider endpoint: ${endpoint}`);
  };
  return fixture;
}
async function setup(t, options = {}) {
  const fixture = provider(options); const store = new MemoryStore();
  const connection = await ChatGPTPlanConnection.create({ fetchImpl: fixture.fetch, store, clock: () => NOW });
  t.after(() => connection.close());
  return { connection, fixture, store };
}
async function begin(connection, fixture, options) {
  const attempt = await connection.startSignIn(options); fixture.auth = new URL(attempt.authorizationUrl);
  return attempt;
}
async function callback(attempt, fixture, overrides = {}) {
  const url = new URL(attempt.redirectUri);
  url.search = new URLSearchParams({ state: fixture.auth.searchParams.get('state'), code: 'stub-one-time-code', client_id: CLIENT, ...overrides }).toString();
  const response = await fetch(url, { redirect: 'error' }); const text = await response.text();
  return { status: response.status, text };
}
async function connected(t, options = {}) {
  const context = await setup(t, options); const attempt = await begin(context.connection, context.fixture);
  assert.equal((await callback(attempt, context.fixture)).status, 200);
  return context;
}
function assertNoCredentials(value) {
  assert.doesNotMatch(JSON.stringify(value), /stub-access-|stub-refresh-|idToken|accessToken|refreshToken|eyJ/);
}

test('documented dynamic PKCE connection, account model discovery and completed inference', async t => {
  const context = await setup(t, { models: [
    { slug: MODEL, display_name: 'Account test model', visibility: 'list' },
    { slug: 'hidden-test-model', display_name: 'Hidden', visibility: 'hidden' },
  ] });
  const { connection, fixture, store } = context;
  assert.equal(fixture.calls.length, 0, 'preparation does not contact an account');
  const attempt = await begin(connection, fixture);
  assert.equal(fixture.auth.origin + fixture.auth.pathname, SIWC.authorize);
  assert.equal(fixture.auth.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(fixture.auth.searchParams.get('agent_name_hint'), 'ScopeGuard');
  assert.equal(fixture.auth.searchParams.get('code_challenge_method'), 'S256');
  assert.match(attempt.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.equal(fixture.auth.searchParams.get('scope'), SIWC.scopes);
  assert.equal(fixture.auth.searchParams.get('resource'), SIWC.resource);
  assert.equal(fixture.auth.searchParams.has('id_token_hint'), false);
  assert.equal((await callback(attempt, fixture)).status, 200);
  assert.equal(connection.status().sharing, true);
  assert.equal(connection.status().selectedModel, null);
  assert.equal(store.record.accounts[0].clientId, CLIENT);
  assert.equal(store.record.accounts[0].identity.subject, 'test-subject');
  assertNoCredentials(connection.status());
  assert.deepEqual(await connection.listModels(), [{ slug: MODEL, displayName: 'Account test model' }]);
  await assert.rejects(connection.selectModel('invented-model'), error => error.status === 400);
  await connection.selectModel(MODEL);
  const assistant = new ChatGPTPlanAssistant({ connection, maxCalls: 2 });
  assert.equal(assistant.configured, true);
  const result = await assistant.assess(SAMPLE);
  assert.equal(result.aiUsed, true); assert.equal(result.model, MODEL); assert.equal(result.requestedModel, MODEL);
  assert.equal(assistant.status().verifiedInferenceCalls, 1); assert.equal(assistant.status().attemptedCalls, 1);
  assertNoCredentials(result); assertNoCredentials(assistant.status());
  const sent = JSON.parse(fixture.calls.find(call => call.endpoint === SIWC.responses).options.body);
  assert.equal(sent.stream, true); assert.equal(sent.store, false); assert.equal(sent.model, MODEL);
  assert.equal(Array.isArray(sent.input), true); assert.equal(sent.input[0].role, 'user');
  for (const unsupported of ['max_output_tokens', 'temperature', 'top_p', 'metadata', 'tools', 'previous_response_id', 'conversation']) assert.equal(unsupported in sent, false);
});

test('wrong state cannot consume sign-in; reuse and concurrent exchange are blocked', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const { connection, fixture } = await setup(t);
  const original = fixture.fetch;
  connection.fetch = async (url, options) => { if (String(url) === SIWC.token) await held; return original(url, options); };
  const attempt = await begin(connection, fixture);
  assert.equal((await callback(attempt, fixture, { state: 'unrelated-state' })).status, 403);
  assert.equal(fixture.codeExchanges, 0); assert.equal(connection.status().signInPending, true);
  const first = callback(attempt, fixture);
  // Wait on observable state, with a deadline, rather than arbitrary sleeps.
  const deadline = Date.now() + 1000;
  while (!connection.pending.consumed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(connection.pending.consumed, true);
  await assert.rejects(connection.startSignIn(), error => error.status === 409);
  const second = await callback(attempt, fixture); assert.equal(second.status, 409);
  release(); assert.equal((await first).status, 200); assert.equal(fixture.codeExchanges, 1);
});

test('ID token signature, issuer, audience, expiry and nonce are checked before activation', async t => {
  const foreign = await generateKeyPair('RS256');
  const cases = [
    { name: 'signature', changes: { key: foreign.privateKey } },
    { name: 'issuer', changes: { issuer: 'https://evil.example' } },
    { name: 'audience', changes: { audience: 'oaiapp_other' } },
    { name: 'expiry', changes: { expiresAt: NOW / 1000 - 100 } },
    { name: 'nonce', changes: { nonce: 'different-nonce' } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const { connection, fixture, store } = await setup(t, { identityChanges: scenario.changes });
    const attempt = await begin(connection, fixture);
    const result = await callback(attempt, fixture);
    assert.equal(result.status, 502); assert.match(result.text, /identity validation failed/);
    assert.equal(connection.status().connected, false);
    assert.equal(store.record.accounts[0].clientId, CLIENT, 'issued registration is retained for retry');
    assert.equal(store.record.accounts[0].credentials, null); assertNoCredentials(connection.status());
    assert.equal(connection.status().accounts[0].validated, false);
    assert.match(connection.status().accounts[0].label, /sign-in needed/);
  });
});

test('returning sign-in reuses issued registration and cannot replace another subject', async t => {
  const { connection, fixture, store } = await connected(t);
  const originalHost = store.record.hostId; const originalIdentity = store.record.accounts[0].identity;
  const attempt = await begin(connection, fixture, { accountId: CLIENT });
  assert.equal(fixture.auth.searchParams.get('client_id'), CLIENT);
  assert.equal(fixture.auth.searchParams.has('agent_name_hint'), false);
  assert.equal(fixture.auth.searchParams.get('ext_agent_host_id'), originalHost);
  const fetchOriginal = fixture.fetch;
  connection.fetch = async (url, options) => {
    const response = await fetchOriginal(url, options);
    if (String(url) !== SIWC.token) return response;
    const data = await response.json(); data.id_token = await identity({ nonce: fixture.auth.searchParams.get('nonce'), subject: 'different-subject' }); return json(data);
  };
  assert.equal((await callback(attempt, fixture)).status, 502);
  assert.equal(connection.status().connected, true);
  assert.deepEqual(store.record.accounts[0].identity, originalIdentity);
  assert.equal(store.record.accounts.length, 1);
});

test('identity-only permission is honest and never attempts inference', async t => {
  const { connection, fixture } = await connected(t, { scope: 'openid profile email offline_access' });
  const assistant = new ChatGPTPlanAssistant({ connection });
  assert.equal(connection.status().connected, true); assert.equal(connection.status().sharing, false); assert.equal(assistant.configured, false);
  await assert.rejects(assistant.assess(SAMPLE), error => error.status === 503);
  assert.equal(fixture.apiCalls, 0); assert.equal(assistant.status().verifiedInferenceCalls, 0);
});

test('failed, interrupted, unidentified, oversized and ungrounded streams never claim AI success', async t => {
  const scenarios = [
    { name: 'response.failed', options: { terminal: 'response.failed' } },
    { name: 'response.incomplete', options: { terminal: 'response.incomplete' } },
    { name: 'premature EOF', options: { truncate: true } },
    { name: 'missing model identity', options: { model: null } },
    { name: 'oversized text', options: { oversized: true } },
    { name: 'ungrounded clauses', options: { text: JSON.stringify({ assessments: offlineAssess(SAMPLE).map(item => ({ ...item, clauseIds: ['UNKNOWN'] })) }) } },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const { connection, fixture } = await connected(t, { responses: () => stream(scenario.options) });
    await connection.selectModel(MODEL); const assistant = new ChatGPTPlanAssistant({ connection, maxCalls: 1 });
    await assert.rejects(assistant.assess(SAMPLE), error => error.status === 502);
    assert.equal(assistant.status().attemptedCalls, 1); assert.equal(assistant.status().verifiedInferenceCalls, 0);
    await assert.rejects(assistant.assess(SAMPLE), error => error.code === 'PROVIDER_CALL_LIMIT');
    assert.equal(fixture.apiCalls, 1);
  });
});

test('returned canonical model metadata is preserved without claiming alias equivalence', async t => {
  const returnedModel = `${MODEL}-2026-10-09`;
  const { connection } = await connected(t, { responses: () => stream({ model: returnedModel }) });
  await connection.selectModel(MODEL); const assistant = new ChatGPTPlanAssistant({ connection });
  const result = await assistant.assess(SAMPLE);
  assert.equal(result.aiUsed, true); assert.equal(result.model, returnedModel); assert.equal(result.returnedModel, returnedModel);
  assert.equal(result.requestedModel, MODEL); assert.equal(result.modelMatchesRequested, false);
  assert.equal(assistant.status().lastVerifiedInference.returnedModel, returnedModel);
  assert.equal(assistant.status().lastVerifiedInference.requestedModel, MODEL);
  assert.equal(assistant.status().verifiedInferenceCalls, 1);
});

test('refused inference counts against budget and cannot silently fall back', async t => {
  const { connection, fixture } = await connected(t, { responses: () => json({ error: 'Do not expose provider payload or secret' }, 429) });
  await connection.selectModel(MODEL); const assistant = new ChatGPTPlanAssistant({ connection, maxCalls: 1 });
  await assert.rejects(assistant.assess(SAMPLE), error => error.status === 503 && !error.message.includes('provider payload'));
  assert.equal(assistant.status().attemptedCalls, 1); assert.equal(assistant.status().verifiedInferenceCalls, 0);
  await assert.rejects(assistant.assess(SAMPLE), error => error.code === 'PROVIDER_CALL_LIMIT'); assert.equal(fixture.apiCalls, 1);
});

test('expired authorization without renewal never consumes an inference attempt', async t => {
  const { connection, fixture } = await connected(t);
  await connection.selectModel(MODEL);
  await connection.commit(record => { record.accounts[0].credentials.expiresAt = NOW - 1; record.accounts[0].credentials.refreshToken = null; });
  const assistant = new ChatGPTPlanAssistant({ connection, maxCalls: 1 });
  await assert.rejects(assistant.assess(SAMPLE), error => error.code === 'SIGN_IN_REQUIRED');
  assert.equal(assistant.status().attemptedCalls, 0); assert.equal(fixture.apiCalls, 0);
});

test('simultaneous requests share one rotating refresh and persist replacement atomically', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const { connection, fixture, store } = await connected(t, { refreshHook: async form => { assert.equal(form.get('refresh_token'), 'stub-refresh-private'); await held; } });
  await connection.commit(record => { record.accounts[0].credentials.expiresAt = NOW + 1000; });
  const first = connection.listModels(); const second = connection.listModels();
  const deadline = Date.now() + 1000;
  while (!fixture.refreshes && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fixture.refreshes, 1); release(); await Promise.all([first, second]);
  assert.equal(fixture.refreshes, 1); assert.equal(store.record.accounts[0].credentials.refreshToken, 'stub-refresh-rotated');
  assert.equal(store.record.accounts[0].credentials.accessToken, 'stub-access-refreshed');
});

test('a prior-session refresh cannot overwrite a newer returning sign-in', { timeout: 5000 }, async t => {
  let release; let entered;
  const held = new Promise(resolve => { release = resolve; }); const refreshing = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const { connection, fixture, store } = await connected(t, { refreshHook: async () => { entered(); await held; } });
  await connection.commit(record => { record.accounts[0].credentials.expiresAt = NOW + 1000; });
  const priorSession = store.record.accounts[0].credentials.sessionId;
  const prior = connection.listModels().then(value => ({ value }), error => ({ error })); await refreshing;
  const attempt = await begin(connection, fixture, { accountId: CLIENT }); assert.equal((await callback(attempt, fixture)).status, 200);
  const currentSession = store.record.accounts[0].credentials.sessionId; assert.notEqual(currentSession, priorSession);
  release(); const result = await prior;
  assert.equal(result.error.code, 'SESSION_CHANGED');
  assert.equal(store.record.accounts[0].credentials.sessionId, currentSession);
  assert.equal(store.record.accounts[0].credentials.accessToken, 'stub-access-private');
  assert.equal(store.record.accounts[0].credentials.refreshToken, 'stub-refresh-private');
  assert.equal(connection.status().connected, true);
});

test('cancel or disconnect during final persistence restores the durable previous state', { timeout: 5000 }, async t => {
  for (const decision of ['cancel', 'disconnect']) await t.test(decision, async t => {
    const { connection, fixture, store } = await setup(t);
    let release; let entered;
    const held = new Promise(resolve => { release = resolve; }); const writing = new Promise(resolve => { entered = resolve; });
    t.after(() => release());
    const write = store.write.bind(store); let hold = true;
    store.write = async record => { if (hold && record.accounts.some(account => account.credentials)) { hold = false; entered(); await held; } await write(record); };
    const attempt = await begin(connection, fixture); const completing = callback(attempt, fixture); await writing;
    let finished = false;
    const deciding = (decision === 'cancel' ? connection.cancelSignIn() : connection.disconnect()).then(result => { finished = true; return result; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false, 'decision waits for durable cleanup');
    release(); assert.equal((await completing).status, 409);
    assert.equal((await deciding).connected, false);
    assert.equal(store.record.accounts[0].credentials, null); assert.equal(store.record.activeAccountId, null);
    const reloaded = await ChatGPTPlanConnection.create({ store: new MemoryStore(store.record), clock: () => NOW });
    try { assert.equal(reloaded.status().connected, false); assert.equal(reloaded.status().accounts[0].validated, false); }
    finally { await reloaded.close(); }
  });
});

test('disconnect waits for token rotation and revokes the latest renewable token', { timeout: 5000 }, async t => {
  let release; let entered;
  const held = new Promise(resolve => { release = resolve; }); const refreshing = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const { connection, fixture, store } = await connected(t, { refreshHook: async () => { entered(); await held; } });
  await connection.commit(record => { record.accounts[0].credentials.expiresAt = NOW + 1000; });
  const listing = connection.listModels().then(value => ({ value }), error => ({ error })); await refreshing;
  const signingOut = connection.disconnect(); release(); const result = await signingOut;
  assert.equal(result.connected, false); assert.equal(result.remoteRevocationConfirmed, true);
  assert.equal((await listing).error.status, 409);
  const revocation = fixture.calls.find(call => call.endpoint.endsWith('/oauth/revoke'));
  assert.equal(new URLSearchParams(revocation.options.body).get('token'), 'stub-refresh-rotated');
  assert.equal(store.record.accounts[0].credentials, null);
});

test('revocation failure still clears local tokens and reports remote revocation unconfirmed', async t => {
  const { connection, store } = await connected(t, { revokeStatus: 503 });
  await connection.selectModel(MODEL);
  const result = await connection.disconnect();
  assert.equal(result.connected, false); assert.equal(result.remoteRevocationConfirmed, false);
  assert.match(result.message, /disconnect ScopeGuard in ChatGPT settings/);
  assert.equal(store.record.accounts[0].credentials, null); assert.equal(store.record.accounts[0].selectedModel, null);
  assert.equal(store.record.accounts[0].clientId, CLIENT); assert.equal(store.record.accounts[0].identity.subject, 'test-subject');
  assertNoCredentials(result);
});

test('failed persistence never activates credentials; cancellation during exchange cannot sign in', async t => {
  const { connection, fixture, store } = await setup(t);
  const attempt = await begin(connection, fixture); const original = fixture.fetch;
  connection.fetch = async (url, options) => { const response = await original(url, options); if (String(url) === SIWC.token) store.fail = true; return response; };
  assert.equal((await callback(attempt, fixture)).status, 502);
  assert.equal(connection.status().connected, false); assert.equal(store.record.accounts[0].credentials, null);
  store.fail = false;
  let release; const held = new Promise(resolve => { release = resolve; });
  connection.fetch = async (url, options) => { if (String(url) === SIWC.token) await held; return original(url, options); };
  const retry = await begin(connection, fixture, { accountId: CLIENT }); const completing = callback(retry, fixture);
  const deadline = Date.now() + 1000;
  while (!connection.pending.consumed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  connection.cancelSignIn(); release(); assert.equal((await completing).status, 409);
  assert.equal(connection.status().connected, false); assert.equal(store.record.accounts[0].credentials, null);
});

test('private storage rejects directory redirects before creating credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'scopeguard-chatgpt-plan-test-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.equal(basename(target).startsWith('scopeguard-chatgpt-plan-test-'), true);
    await rm(target, { recursive: true, force: true });
  });
  const ordinary = join(directory, 'ordinary');
  const redirect = join(directory, 'redirect');
  await mkdir(ordinary);
  // NTFS junction creation does not require administrator/developer privileges.
  await symlink(ordinary, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ChatGPTPlanConnection.create({ store: new PrivateCredentialStore(join(redirect, 'chatgpt-plan')) }), /ordinary application credential directory/);
  await assert.rejects(readFile(join(ordinary, 'chatgpt-plan', 'connection.json')), { code: 'ENOENT' });
});

test('real dedicated private storage persists registration and rejects a second process owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'scopeguard-chatgpt-plan-test-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.equal(basename(target).startsWith('scopeguard-chatgpt-plan-test-'), true);
    await rm(target, { recursive: true, force: true });
  });
  const dedicated = join(directory, 'chatgpt-plan');
  if (process.platform === 'win32') {
    // Reproduce secondary-drive inherited Modify permissions: owner has
    // implicit WRITE_DAC, but explicitly setting the owner needs WRITE_OWNER.
    // Protection must succeed by preserving ownership rather than weakening it.
    const script = "$ErrorActionPreference='Stop'; $p=$env:SCOPEGUARD_PRIVATE_DIRECTORY; [System.IO.Directory]::CreateDirectory($p) | Out-Null; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'; $prop=[System.Security.AccessControl.PropagationFlags]::None; $allow=[System.Security.AccessControl.AccessControlType]::Allow; $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'Modify',$inherit,$prop,$allow))); $system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system,'FullControl',$inherit,$prop,$allow))); [System.IO.Directory]::SetAccessControl($p,$acl)";
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, env: { ...process.env, SCOPEGUARD_PRIVATE_DIRECTORY: dedicated } });
  }
  const first = await ChatGPTPlanConnection.create({ store: new PrivateCredentialStore(dedicated) });
  const hostId = first.record.hostId;
  try {
    await assert.rejects(ChatGPTPlanConnection.create({ store: new PrivateCredentialStore(dedicated) }), error => error.code === 'CONNECTION_IN_USE');
    const disk = JSON.parse(await readFile(join(dedicated, 'connection.json'), 'utf8'));
    assert.equal(disk.hostId, hostId); assert.equal(disk.accounts.length, 0);
  } finally { await first.close(); }
  const reloaded = await ChatGPTPlanConnection.create({ store: new PrivateCredentialStore(dedicated) });
  try { assert.equal(reloaded.record.hostId, hostId); assert.equal(reloaded.status().connected, false); }
  finally { await reloaded.close(); }
});
