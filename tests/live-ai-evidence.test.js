import test from 'node:test';
import assert from 'node:assert/strict';
import { captureChatGPTPlanEvidence } from '../scripts/capture-chatgpt-evidence.js';
import { groundAssessment, offlineAssess, SAMPLE, SCOPE } from '../src/domain.js';

// Synthetic local API responses only: no sign-in, model or payment requests.
const selectedModel = 'account-model-alias';
const ready = { available: true, connected: true, sharing: true, selectedModel, signInPending: false, attemptedCalls: 0, verifiedInferenceCalls: 0, callsRemaining: 10 };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const result = () => ({ id: '9cda57de-01b6-4be6-8ea6-8687ef3bb7f2', provider: 'ChatGPT plan via Sign in with ChatGPT', aiUsed: true, model: 'account-model-canonical-2026', provenance: { requestedModel: selectedModel, returnedModel: 'account-model-canonical-2026', modelMatchesRequested: false, responseId: 'synthetic-response-test' }, items: groundAssessment(SAMPLE, offlineAssess(SAMPLE)) });

test('one-shot evidence requires explicit consent and connected setup before dispatch', async () => {
  let requests = 0;
  const denied = async () => { requests++; throw new Error('Unexpected request'); };
  await assert.rejects(captureChatGPTPlanEvidence({ fetchImpl: denied }), /confirm-plan-use/);
  await assert.rejects(captureChatGPTPlanEvidence({ confirmPlanUse: true, url: 'https://example.com', fetchImpl: denied }), /loopback/);
  assert.equal(requests, 0);
  for (const changes of [{ connected: false }, { sharing: false }, { selectedModel: null }, { signInPending: true }, { callsRemaining: 0 }]) {
    const paths = [];
    const stub = async url => { paths.push(new URL(url).pathname); return json({ scope: SCOPE, sample: SAMPLE, nebiusConfigured: true, chatgptPlan: { ...ready, ...changes } }); };
    await assert.rejects(captureChatGPTPlanEvidence({ confirmPlanUse: true, fetchImpl: stub }), /No assessment was dispatched/);
    assert.deepEqual(paths, ['/api/config']);
  }
  const changedSample = async () => json({ scope: SCOPE, sample: [{ ...SAMPLE[0], details: 'Other client data is not allowed here.' }], chatgptPlan: ready });
  await assert.rejects(captureChatGPTPlanEvidence({ confirmPlanUse: true, fetchImpl: changedSample }), /only ScopeGuard’s fixed fictional/);
});

test('one explicit fictional assessment preserves actual canonical identity and excludes unrelated private metadata', async () => {
  const calls = [];
  const stub = async (url, options) => {
    const path = new URL(url).pathname; calls.push({ path, options });
    if (path === '/api/config') return json({ scope: SCOPE, sample: SAMPLE, chatgptPlan: { ...ready, accounts: [{ email: 'not-for-export@example.invalid' }] } });
    if (path === '/api/assess') return json({ ...result(), credentials: { access_token: 'synthetic-private-metadata' } });
    if (path === '/api/chatgpt/status') return json({ attemptedCalls: 1, verifiedInferenceCalls: 1, accounts: [{ subject: 'synthetic-private-subject' }] });
    throw new Error('Unexpected endpoint');
  };
  const evidence = await captureChatGPTPlanEvidence({ confirmPlanUse: true, fetchImpl: stub });
  assert.deepEqual(calls.map(call => call.path), ['/api/config', '/api/assess', '/api/chatgpt/status']);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(calls[1].options.body), { aiMode: 'chatgpt-plan', requests: SAMPLE });
  assert.equal(calls[1].options.redirect, 'error');
  assert.deepEqual(evidence.assessment.provenance, result().provenance);
  assert.equal(evidence.inferenceAttemptsByThisCommand, 1); assert.equal(evidence.paypalRequestsByThisCommand, 0);
  assert.equal(evidence.assessment.items.length, SAMPLE.length);
  assert.doesNotMatch(JSON.stringify(evidence), /access_token|synthetic-private|not-for-export|accounts/);
});

test('failed or unverifiable inference never retries or creates substitute evidence', async () => {
  for (const response of [() => json({ error: 'Synthetic failure' }, 502), () => json({ ...result(), aiUsed: false }), () => json({ ...result(), id: { private: 'Unexpected metadata' } }), () => json({ ...result(), provenance: { ...result().provenance, returnedModel: selectedModel } })]) {
    const paths = [];
    const stub = async url => {
      const path = new URL(url).pathname; paths.push(path);
      if (path === '/api/config') return json({ scope: SCOPE, sample: SAMPLE, chatgptPlan: ready });
      if (path === '/api/assess') return response();
      throw new Error('No followup is expected');
    };
    await assert.rejects(captureChatGPTPlanEvidence({ confirmPlanUse: true, fetchImpl: stub }), /No automatic retry|No evidence was accepted/);
    assert.deepEqual(paths, ['/api/config', '/api/assess']);
  }
  const paths = [];
  const concurrent = async url => {
    const path = new URL(url).pathname; paths.push(path);
    if (path === '/api/config') return json({ scope: SCOPE, sample: SAMPLE, chatgptPlan: ready });
    if (path === '/api/assess') return json(result());
    return json({ attemptedCalls: 2, verifiedInferenceCalls: 2 });
  };
  await assert.rejects(captureChatGPTPlanEvidence({ confirmPlanUse: true, fetchImpl: concurrent }), /Review concurrent usage/);
  assert.deepEqual(paths, ['/api/config', '/api/assess', '/api/chatgpt/status']);
});
