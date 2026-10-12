import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTPlanAssistant, ChatGPTPlanConnection, SIWC } from '../src/chatgpt-plan.js';
import { SAMPLE, offlineAssess } from '../src/domain.js';

// Memory-only synthetic grants and injected streams; no OAuth, account catalog,
// credential files, running app or provider endpoint is contacted.
const NOW = Date.parse('2026-10-12T00:00:00Z');
const CLIENT = 'oaiapp_diagnostic_fixture';
const MODEL = 'synthetic-diagnostic-model';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MARKER = 'synthetic-private-token-message-detail';
async function fixture(t, response) {
  const record = { version: 1, hostId: 'urn:uuid:7db82b08-516d-4f58-bf25-1a49b76458dd', activeAccountId: CLIENT,
    accounts: [{ clientId: CLIENT, identity: { issuer: SIWC.issuer, subject: 'synthetic-subject' }, selectedModel: MODEL,
      credentials: { accessToken: MARKER, refreshToken: null, scopes: SIWC.scopes.split(' '), expiresAt: NOW + 3600000 } }] };
  const calls = [];
  const connection = await ChatGPTPlanConnection.create({ clock: () => NOW,
    store: { async acquire() {}, async read() { return structuredClone(record); }, async write() {}, async close() {} },
    fetchImpl: async (url, options) => { assert.equal(String(url), SIWC.responses); calls.push(options); return typeof response === 'function' ? response(options) : response; } });
  connection.catalog.set(CLIENT, { receivedAt: NOW, models: [{ slug: MODEL, displayName: 'Synthetic diagnostic model' }] });
  t.after(() => connection.close());
  return { connection, calls, assistant: new ChatGPTPlanAssistant({ connection, maxCalls: 1 }) };
}
function byteBody(bytes, { chunkSize = 4096, keepOpen = false } = {}) {
  const source = Uint8Array.from(typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
  const stats = { delivered: 0, pulls: 0, cancelled: false, viewLengths: [] };
  const body = new ReadableStream({ type: 'bytes',
    pull(controller) {
      stats.pulls++;
      if (stats.delivered === source.length) { if (!keepOpen) { controller.close(); controller.byobRequest?.respond(0); } return; }
      const request = controller.byobRequest; assert.ok(request, 'Diagnostic reads must use BYOB');
      stats.viewLengths.push(request.view.byteLength);
      const count = Math.min(request.view.byteLength, chunkSize, source.length - stats.delivered);
      request.view.set(source.subarray(stats.delivered, stats.delivered + count)); stats.delivered += count;
      request.respond(count); if (stats.delivered === source.length && !keepOpen) controller.close();
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, stats };
}
async function refuse(assistant, diagnosticRejectedResponses = true) {
  let failure;
  await assert.rejects(assistant.assess({ requests: SAMPLE, diagnosticRejectedResponses }), error => { failure = error; return true; });
  assert.equal(assistant.status().attemptedCalls, 1); assert.equal(assistant.status().verifiedInferenceCalls, 0);
  assert.doesNotMatch(failure.message + JSON.stringify(failure) + JSON.stringify(assistant.status().lastRequestDiagnostic), new RegExp(MARKER));
  return failure;
}

test('ordinary failed assessments retain safe request tracing but cancel rejected bodies unread', async t => {
  let reads = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(Buffer.from(MARKER)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const requestId = 'req_' + 'a'.repeat(32);
  const { assistant, calls, connection } = await fixture(t, { ok: false, status: 403, body,
    headers: new Headers({ 'Content-Type': 'application/json', 'x-request-id': requestId, 'openai-request-id': MARKER }) });
  const failure = await refuse(assistant, false); const diagnostic = failure.providerDiagnostic;
  assert.equal(reads, 0); assert.equal(cancelled, true); assert.equal(calls.length, 1);
  assert.match(calls[0].headers['X-Client-Request-Id'], UUID);
  assert.equal(diagnostic.clientRequestId, calls[0].headers['X-Client-Request-Id']);
  assert.equal(diagnostic.requestId, requestId); assert.equal(diagnostic.openaiRequestId, null);
  assert.equal(diagnostic.rejectedBodyDiagnosticsEnabled, false); assert.equal(Object.hasOwn(diagnostic, 'bodyShape'), false);
  assert.ok(diagnostic.elapsedMs >= diagnostic.headersElapsedMs);
  assert.deepEqual(connection.status().lastRequestDiagnostic, diagnostic);
  const copy = connection.status().lastRequestDiagnostic; copy.requestId = MARKER;
  assert.equal(connection.status().lastRequestDiagnostic.requestId, requestId, 'Status returns an isolated copy');
});

test('diagnostic JSON errors retain only enumerated code and param without exposing message or detail', async t => {
  const payload = JSON.stringify({ error: { code: 'subscription_sharing_unsupported_capability', param: 'max_output_tokens', message: MARKER }, detail: MARKER, access_token: MARKER });
  const { body, stats } = byteBody(payload, { chunkSize: 7 });
  const { assistant, calls } = await fixture(t, { ok: false, status: 400, headers: new Headers(), body });
  const failure = await refuse(assistant); const diagnostic = failure.providerDiagnostic;
  assert.equal(failure.code, 'PLAN_REQUEST_FAILED'); assert.equal(diagnostic.bodyShape, 'json_error');
  assert.equal(diagnostic.providerErrorCode, 'subscription_sharing_unsupported_capability');
  assert.equal(diagnostic.providerErrorParam, 'max_output_tokens');
  assert.equal(diagnostic.sampledBytes, Buffer.byteLength(payload)); assert.equal(stats.delivered, Buffer.byteLength(payload));
  assert.equal(diagnostic.sampleLimitReached, false); assert.equal(diagnostic.bodySampleStatus, 'complete');
  assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, true);
});

test('diagnostic sampling never accepts missing MIME even when its byte stream contains a complete assessment', async t => {
  const text = JSON.stringify({ assessments: offlineAssess(SAMPLE) });
  const completed = `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'synthetic-response', model: MODEL, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } })}\n\n`;
  const { body } = byteBody(completed);
  const { assistant, calls } = await fixture(t, { ok: true, status: 200, headers: new Headers(), body });
  const failure = await refuse(assistant);
  assert.equal(failure.code, 'STREAM_INVALID'); assert.equal(failure.providerDiagnostic.contentTypeCategory, 'missing');
  assert.equal(failure.providerDiagnostic.bodyShape, 'sse_like'); assert.equal(calls.length, 1);
  await assert.rejects(assistant.assess(SAMPLE), error => error.code === 'PROVIDER_CALL_LIMIT');
  assert.equal(calls.length, 1, 'Diagnostic refusal cannot retry or bypass the attempt budget');
});

test('diagnostic reads stop at4KiB and unsupported ordinary readers are cancelled before any oversized chunk', async t => {
  const bytes = byteBody('x'.repeat(100000));
  const first = await fixture(t, { ok: true, status: 200, headers: new Headers(), body: bytes.body });
  const failure = await refuse(first.assistant);
  assert.equal(bytes.stats.delivered, 4096); assert.equal(bytes.stats.pulls, 1); assert.equal(bytes.stats.cancelled, true);
  assert.deepEqual(bytes.stats.viewLengths, [4096]);
  assert.equal(failure.providerDiagnostic.sampledBytes, 4096); assert.equal(failure.providerDiagnostic.sampleLimitReached, true);
  let reads = 0, cancelled = false;
  const ordinary = new ReadableStream({ pull(controller) { reads++; controller.enqueue(Buffer.alloc(100000)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const second = await fixture(t, { ok: true, status: 200, headers: new Headers(), body: ordinary });
  const unavailable = await refuse(second.assistant);
  assert.equal(reads, 0); assert.equal(cancelled, true);
  assert.equal(unavailable.providerDiagnostic.bodySampleStatus, 'unsupported_reader'); assert.equal(unavailable.providerDiagnostic.sampledBytes, 0);
});

test('diagnostic shapes and unknown fields are fixed categories and never free provider text', async t => {
  for (const [payload, shape, sampleStatus] of [
    [JSON.stringify({ detail: MARKER }), 'json_detail', 'complete'],
    [JSON.stringify({ error: { code: MARKER, param: MARKER, message: MARKER } }), 'json_error', 'complete'],
    ['<html>' + MARKER, 'html_like', 'complete'],
    [JSON.stringify([MARKER]), 'json_other', 'complete'],
    [MARKER, 'unknown', 'complete'],
    [new Uint8Array([0xff, 0xfe]), 'unknown', 'invalid_utf8'],
  ]) {
    const { body } = byteBody(payload);
    const { assistant } = await fixture(t, { ok: false, status: 503, headers: new Headers(), body });
    const failure = await refuse(assistant);
    assert.equal(failure.providerDiagnostic.bodyShape, shape); assert.equal(failure.providerDiagnostic.bodySampleStatus, sampleStatus);
    assert.equal(failure.providerDiagnostic.providerErrorCode, null); assert.equal(failure.providerDiagnostic.providerErrorParam, null);
  }
});

test('stalled diagnostic reads and cancellation have a bounded deadline and abort the request', { timeout: 4000 }, async t => {
  let cancelled = false;
  const body = new ReadableStream({ type: 'bytes', pull() {}, cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const { assistant, calls } = await fixture(t, { ok: true, status: 200, headers: new Headers(), body });
  const began = performance.now(); const failure = await refuse(assistant);
  assert.ok(performance.now() - began < 2500);
  assert.equal(failure.providerDiagnostic.bodySampleStatus, 'timeout'); assert.equal(failure.providerDiagnostic.sampledBytes, 0);
  assert.equal(cancelled, true); assert.equal(calls[0].signal.aborted, true); assert.equal(calls.length, 1);
});

test('transport failures retain generated request identity without copying exception text', async t => {
  const { assistant, calls } = await fixture(t, () => { throw Error(MARKER); });
  const failure = await refuse(assistant, false);
  assert.match(failure.message, /ChatGPT plan request failed/);
  assert.equal(failure.providerDiagnostic.responseReceived, false); assert.equal(failure.providerDiagnostic.httpStatus, null);
  assert.equal(failure.providerDiagnostic.requestId, null); assert.equal(failure.providerDiagnostic.headersElapsedMs, null);
  assert.equal(failure.providerDiagnostic.clientRequestId, calls[0].headers['X-Client-Request-Id']);
  assert.equal(calls.length, 1);
});
