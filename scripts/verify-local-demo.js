import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { ScopeAssistant, PayPalSandbox } from '../src/providers.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const denyExternalRequest = async () => { throw new Error('External provider traffic is forbidden in this local verification.'); };
// Explicit empty configuration means .env or shell credentials cannot turn
// this reproduction into an account request.
const server = await startServer({ port: 0, assistant: new ScopeAssistant({ fetchImpl: denyExternalRequest }), paypal: new PayPalSandbox({ fetchImpl: denyExternalRequest }), planConnection: null });
async function post(path, data, expectedStatus = 200) {
  const response = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url }, body: JSON.stringify(data), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, expectedStatus, `Unexpected status for ${path}`);
  return response.json();
}
try {
  const response = await fetch(`${server.url}/api/config`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); const config = await response.json();
  assert.equal(config.paypalConfigured, false); assert.equal(config.chatgptPlan.available, false);
  const assessment = await post('/api/assess', { aiMode: 'local', requests: config.sample });
  assert.equal(assessment.aiUsed, false); assert.equal(assessment.model, null);
  assert.deepEqual(assessment.items.map(item => [item.id, item.classification]), [['R1', 'change_order'], ['R2', 'change_order'], ['R3', 'included']]);
  const quote = await post('/api/quote', { assessmentId: assessment.id, selectedIds: ['R1', 'R2'], rateCents: 5000 });
  assert.equal(quote.totalCents, 50000); assert.equal(quote.status, 'preview');
  const approvedQuote = await post('/api/approve', { quoteId: quote.id, fingerprint: quote.fingerprint });
  assert.equal(approvedQuote.status, 'approved'); assert.equal(approvedQuote.totalCents, 50000);
  const unavailable = await post('/api/invoice', { quoteId: quote.id, sandboxBuyerEmail: 'fictional-buyer@example.invalid' }, 503);
  assert.match(unavailable.error, /not configured/i);
  const evidence = { schemaVersion: 1, capturedAt: new Date().toISOString(), mode: 'local rules', liveAiUsed: false, actualPayPalInvoiceCreated: false, scope: config.scope, requests: config.sample, assessment, approvedQuote, sponsorIntegrationStatus: 'Unconfigured; no provider traffic permitted by this verification.' };
  const output = resolve(root, 'artifacts', 'local-demo-evidence.json');
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ verified: true, mode: evidence.mode, quoteTotalUSD: '500.00', selectedRequests: ['R1', 'R2'], liveAiUsed: false, actualPayPalInvoiceCreated: false, evidenceFile: output }, null, 2));
} finally { await server.close(); }
