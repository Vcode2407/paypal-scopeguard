import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { groundAssessment, SAMPLE, SCOPE } from '../src/domain.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelId = input => typeof input === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(input);
const assessmentId = input => typeof input === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
const count = input => Number.isInteger(input) && input >= 0;

async function jsonResponse(response) {
  if (!response.ok) throw new Error(`ScopeGuard refused the request (HTTP ${response.status}). No automatic retry or fallback was attempted.`);
  if (!response.headers.get('content-type')?.startsWith('application/json') || !response.body) throw new Error('ScopeGuard returned an unexpected response. No evidence was accepted.');
  const reader = response.body.getReader(); const parts = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 120000) throw new Error('ScopeGuard evidence exceeded the bounded response limit.');
      parts.push(value);
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new Error('ScopeGuard returned unreadable evidence.'); }
  } finally { await reader.cancel().catch(() => {}); }
}

/** One explicit assessment only. Never initiates sign-in, model selection or payments. */
export async function captureChatGPTPlanEvidence({ confirmPlanUse = false, url = 'http://127.0.0.1:4185', fetchImpl = fetch } = {}) {
  if (confirmPlanUse !== true) throw new Error('Pass --confirm-plan-use only after consenting to one fictional assessment using your connected ChatGPT plan.');
  let base;
  try { base = new URL(url); } catch { throw new Error('Use the local ScopeGuard loopback URL.'); }
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Use the local ScopeGuard loopback URL with an explicit port.');
  const request = async (path, options = {}) => jsonResponse(await fetchImpl(`${base.origin}${path}`, { ...options, headers: { ...options.headers, Origin: base.origin }, redirect: 'error', signal: AbortSignal.timeout(options.method === 'POST' ? 30000 : 5000) }));
  const config = await request('/api/config'); const before = config.chatgptPlan;
  if (JSON.stringify(config.scope) !== JSON.stringify(SCOPE) || JSON.stringify(config.sample) !== JSON.stringify(SAMPLE)) throw new Error('This command accepts only ScopeGuard’s fixed fictional scope and sample.');
  if (!before?.available || !before.connected || !before.sharing || before.signInPending || !modelId(before.selectedModel) || !count(before.attemptedCalls) || !count(before.verifiedInferenceCalls) || !Number.isInteger(before.callsRemaining) || before.callsRemaining < 1) throw new Error('Complete the official sign-in and plan consent, select an account-returned model, and confirm available call budget first. No assessment was dispatched.');

  // The only POST in this command. It has no retry and cannot select Nebius,
  // connect an account, create a quote, approve work or contact PayPal.
  const assessment = await request('/api/assess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiMode: 'chatgpt-plan', requests: SAMPLE }) });
  const provenance = assessment.provenance;
  if (!assessmentId(assessment.id) || assessment.aiUsed !== true || assessment.provider !== 'ChatGPT plan via Sign in with ChatGPT' || !modelId(assessment.model) || provenance?.requestedModel !== before.selectedModel || provenance.returnedModel !== assessment.model || provenance.modelMatchesRequested !== (provenance.requestedModel === provenance.returnedModel) || typeof provenance.responseId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(provenance.responseId)) throw new Error('The assessment did not supply valid completed ChatGPT provenance. No evidence was accepted and no retry was attempted.');
  let items;
  try {
    items = groundAssessment(SAMPLE, assessment.items?.map(item => ({ requestId: item.id, classification: item.classification, reason: item.reason, clauseIds: item.clauses?.map(clause => clause.id) })));
  } catch { throw new Error('The completed assessment did not contain grounded fictional scope evidence.'); }
  const after = await request('/api/chatgpt/status');
  if (after.attemptedCalls !== before.attemptedCalls + 1 || after.verifiedInferenceCalls !== before.verifiedInferenceCalls + 1) throw new Error('The inference counters do not identify one accepted assessment. Review concurrent usage; no automatic retry was attempted.');
  return {
    schemaVersion: 1, capturedAt: new Date().toISOString(), source: 'ScopeGuard loopback API',
    liveAiUsed: true, inferenceAttemptsByThisCommand: 1, acceptedAssessmentsByThisCommand: 1, paypalRequestsByThisCommand: 0,
    scope: SCOPE, requests: SAMPLE,
    assessment: { id: assessment.id, provider: assessment.provider, aiUsed: true, model: assessment.model, provenance: { requestedModel: provenance.requestedModel, returnedModel: provenance.returnedModel, modelMatchesRequested: provenance.modelMatchesRequested, responseId: provenance.responseId }, items },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--confirm-plan-use' && !/^--port=\d{1,5}$/.test(arg))) throw new Error('Usage: npm run evidence:chatgpt -- --confirm-plan-use [--port=4185]');
    const ports = args.filter(arg => arg.startsWith('--port=')); const port = ports.length ? Number(ports[0].slice(7)) : 4185;
    if (ports.length > 1 || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose one local port between 1024 and 65535.');
    const evidence = await captureChatGPTPlanEvidence({ confirmPlanUse: args.includes('--confirm-plan-use'), url: `http://127.0.0.1:${port}` });
    const output = resolve(ROOT, 'artifacts', 'chatgpt-live-evidence.json');
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({ evidenceFile: output, liveAiUsed: evidence.liveAiUsed, ...evidence.assessment.provenance, inferenceAttemptsByThisCommand: 1, paypalRequestsByThisCommand: 0 }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
