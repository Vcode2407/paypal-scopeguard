import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../src/server.js';
import {Workflow,SAMPLE,SCOPE,validateRequests,groundAssessment,offlineAssess,invoicePayload,Problem,verifyInvoiceTotal} from '../src/domain.js';
import {ScopeAssistant,PayPalSandbox,PAYPAL_BASE} from '../src/providers.js';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
async function post(app,path,data,origin){const response=await fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(data)});return {status:response.status,data:await response.json()};}
async function fixture(t,options={}){const app=await startServer({port:0,...options});t.after(()=>app.close());return app;}
test('local assessment grounds each suggestion in actual scope clauses',async t=>{
  const app=await fixture(t);const result=await post(app,'/api/assess',{requests:SAMPLE});assert.equal(result.status,200);assert.equal(result.data.aiUsed,false);assert.equal(result.data.items[0].classification,'change_order');assert.equal(result.data.items[2].classification,'included');assert.deepEqual(result.data.items[0].clauses,[SCOPE[2],SCOPE[3]]);
});
test('reviewed extra work is priced deterministically and requires exact approval',async t=>{
  const app=await fixture(t);const assessed=(await post(app,'/api/assess',{requests:SAMPLE})).data;const preview=(await post(app,'/api/quote',{assessmentId:assessed.id,selectedIds:['R1','R2'],rateCents:5000})).data;
  assert.equal(preview.totalCents,50000);assert.equal(preview.status,'preview');assert.equal((await post(app,'/api/invoice',{quoteId:preview.id,sandboxBuyerEmail:'buyer@example.test'})).status,409);
  assert.equal((await post(app,'/api/approve',{quoteId:preview.id,fingerprint:'edited-total'})).status,409);
  const approved=await post(app,'/api/approve',{quoteId:preview.id,fingerprint:preview.fingerprint});assert.equal(approved.data.status,'approved');
  assert.equal((await post(app,'/api/invoice',{quoteId:preview.id,sandboxBuyerEmail:'buyer@example.test'})).status,503);
});
test('included, duplicate and unknown requests cannot become billable quote items',async t=>{
  const app=await fixture(t);const assessment=(await post(app,'/api/assess',{requests:SAMPLE})).data;
  for(const selectedIds of [['R3'],['R1','R1'],['not-a-request'],[]])assert.equal((await post(app,'/api/quote',{assessmentId:assessment.id,selectedIds,rateCents:5000})).status,400);
});
test('malformed estimates are rejected before any provider invocation',async t=>{
  let calls=0;const app=await fixture(t,{assistant:{async assess(){calls++;throw Error('must not run');}}});
  for(const hours of [-1,Infinity,.1,101])assert.equal((await post(app,'/api/assess',{requests:[{...SAMPLE[0],hours}]})).status,400);
  assert.equal(calls,0);
});
test('AI returns actual provider provenance while invented clause IDs are rejected',async()=>{
  const requests=validateRequests(SAMPLE);let observed;
  const assistant=new ScopeAssistant({key:'test-key',model:'nvidia/test-model',fetchImpl:async(url,options)=>{observed={url,body:JSON.parse(options.body)};return json({model:'nvidia/test-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify({assessments:offlineAssess(requests)})}}]});}});
  const result=await assistant.assess(requests);assert.equal(result.aiUsed,true);assert.equal(result.model,'nvidia/test-model');assert.equal(observed.url,'https://api.tokenfactory.nebius.com/v1/chat/completions');assert.equal(observed.body.max_tokens,1800);assert.equal(groundAssessment(requests,result.assessments).length,3);
  result.assessments[0].clauseIds=['C999'];assert.throws(()=>groundAssessment(requests,result.assessments),/unsupported scope evidence/);
});
test('provider errors are sanitized and incomplete outputs do not create assessments',async t=>{
  const assistant=new ScopeAssistant({key:'secret-key',model:'nvidia/test-model',fetchImpl:async()=>json({error:'do not expose secret-key'},401)});
  const app=await fixture(t,{assistant});const response=await post(app,'/api/assess',{requests:SAMPLE});assert.equal(response.status,502);assert.ok(!JSON.stringify(response.data).includes('secret-key'));
});
test('sandbox adapter uses OAuth, stable request IDs and authoritative invoice status',async t=>{
  const calls=[];const paypal=new PayPalSandbox({clientId:'test-id',secret:'test-secret',fetchImpl:async(url,options)=>{calls.push({url,options});if(url.endsWith('/token'))return json({access_token:'stub-token',expires_in:3600});if(options.method==='POST')return json({href:`${PAYPAL_BASE}/v2/invoicing/invoices/INV2-TEST-1234`},201);return json({id:'INV2-TEST-1234',status:'DRAFT',amount:{currency_code:'USD',value:'200.00'}});}});
  const app=await fixture(t,{paypal});const assessment=(await post(app,'/api/assess',{requests:SAMPLE})).data;const quote=(await post(app,'/api/quote',{assessmentId:assessment.id,selectedIds:['R1'],rateCents:5000})).data;await post(app,'/api/approve',{quoteId:quote.id,fingerprint:quote.fingerprint});
  const first=await post(app,'/api/invoice',{quoteId:quote.id,sandboxBuyerEmail:'sandbox-buyer@example.test'});const again=await post(app,'/api/invoice',{quoteId:quote.id,sandboxBuyerEmail:'sandbox-buyer@example.test'});
  assert.equal(first.data.id,'INV2-TEST-1234');assert.equal(first.data.status,'DRAFT');assert.equal(again.data.id,first.data.id);assert.equal(again.data.status,'DRAFT');assert.equal(calls.filter(call=>call.options.method==='POST'&&!call.url.endsWith('/token')).length,1);assert.equal(calls.length,4);assert.ok(calls[1].options.headers['PayPal-Request-Id']);assert.ok(calls.every(item=>item.url.startsWith(PAYPAL_BASE)));assert.equal(JSON.parse(calls[1].options.body).items[0].unit_amount.value,'200.00');
  assert.equal((await post(app,'/api/invoice',{quoteId:quote.id,sandboxBuyerEmail:'other@example.test'})).status,409);
});
test('a failed invoice retry cannot change recipient or request ID',async t=>{
  const ids=[];const paypal={configured:true,async createDraft(payload,id){ids.push(id);throw new Problem('temporary sandbox failure',502);}};const app=await fixture(t,{paypal});const assessment=(await post(app,'/api/assess',{requests:SAMPLE})).data;const quote=(await post(app,'/api/quote',{assessmentId:assessment.id,selectedIds:['R1'],rateCents:5000})).data;await post(app,'/api/approve',{quoteId:quote.id,fingerprint:quote.fingerprint});
  const data={quoteId:quote.id,sandboxBuyerEmail:'buyer@example.test'};assert.equal((await post(app,'/api/invoice',data)).status,502);assert.equal((await post(app,'/api/invoice',{...data,sandboxBuyerEmail:'other@example.test'})).status,409);assert.equal((await post(app,'/api/invoice',data)).status,502);assert.equal(ids[0],ids[1]);
});
test('invoice payload and remote amount must match the approved deterministic quote',async()=>{
  const workflow=new Workflow();const assessment=workflow.retain({id:'A',createdAt:workflow.clock(),items:groundAssessment(SAMPLE,offlineAssess(SAMPLE))});const quote=workflow.preview({assessmentId:assessment.id,selectedIds:['R1'],rateCents:5000});assert.throws(()=>invoicePayload(quote,'buyer@example.test'),/Approve/);const approved=workflow.approve(quote.id,quote.fingerprint);const payload=invoicePayload(approved,'buyer@example.test');
  assert.equal(payload.detail.reference,quote.id);
  assert.deepEqual(payload.configuration,{allow_tip:false,partial_payment:{allow_partial_payment:false}});
  assert.throws(()=>verifyInvoiceTotal(approved,{amount:{currency_code:'USD',value:'999.00'}}),/total differs/);
  assert.throws(()=>verifyInvoiceTotal(approved,{amount:null}),/unavailable/);
});
test('repeat creation rechecks failed status and mismatch without a second creation or recipient change',async t=>{
  let creates=0,reads=0;const paypal={configured:true,async createDraft(){creates++;return {id:'INV2-RETRY',status:'STATUS_UNVERIFIED'};},async details(id){reads++;if(reads===1)throw new Problem('temporary detail failure',502);if(reads===2)return {id,status:'DRAFT',amount:{currency_code:'USD',value:'999.00'}};return {id,status:'DRAFT',amount:{currency_code:'USD',value:'200.00'}};}};
  const app=await fixture(t,{paypal});const assessment=(await post(app,'/api/assess',{requests:SAMPLE})).data;const quote=(await post(app,'/api/quote',{assessmentId:assessment.id,selectedIds:['R1'],rateCents:5000})).data;await post(app,'/api/approve',{quoteId:quote.id,fingerprint:quote.fingerprint});const data={quoteId:quote.id,sandboxBuyerEmail:'buyer@example.test'};
  assert.equal((await post(app,'/api/invoice',data)).status,502);assert.equal((await post(app,'/api/invoice',{...data,sandboxBuyerEmail:'different@example.test'})).status,409);const mismatch=await post(app,'/api/invoice',data);assert.equal(mismatch.status,502);assert.equal(mismatch.data.invoice.status,'STATUS_UNVERIFIED');assert.equal((await post(app,'/api/invoice',data)).status,200);assert.equal(creates,1);assert.equal(reads,3);
});
test('unknown creation outcome blocks another POST while a known invoice survives status failure',async t=>{
  let creates=0;const unknown={configured:true,async createDraft(){creates++;const error=new Problem('network interrupted',502);error.creationMayExist=true;throw error;}};const app=await fixture(t,{paypal:unknown});const assessment=(await post(app,'/api/assess',{requests:SAMPLE})).data;const quote=(await post(app,'/api/quote',{assessmentId:assessment.id,selectedIds:['R1'],rateCents:5000})).data;await post(app,'/api/approve',{quoteId:quote.id,fingerprint:quote.fingerprint});const data={quoteId:quote.id,sandboxBuyerEmail:'buyer@example.test'};
  assert.equal((await post(app,'/api/invoice',data)).status,502);assert.equal((await post(app,'/api/invoice',data)).status,409);assert.equal(creates,1);
  let reads=0;const known={configured:true,async createDraft(){return {id:'INV2-KNOWN',status:'STATUS_UNVERIFIED',source:'PayPal sandbox'};},async details(id){reads++;if(reads===1)throw new Problem('status temporarily unavailable',502);return {id,status:'DRAFT',amount:{currency_code:'USD',value:'200.00'}};}};const second=await fixture(t,{paypal:known});const assessed=(await post(second,'/api/assess',{requests:SAMPLE})).data;const preview=(await post(second,'/api/quote',{assessmentId:assessed.id,selectedIds:['R1'],rateCents:5000})).data;await post(second,'/api/approve',{quoteId:preview.id,fingerprint:preview.fingerprint});const failed=await post(second,'/api/invoice',{quoteId:preview.id,sandboxBuyerEmail:'buyer@example.test'});assert.equal(failed.status,502);assert.equal(failed.data.invoice.id,'INV2-KNOWN');const recovered=await post(second,'/api/invoice-status',{quoteId:preview.id});assert.equal(recovered.data.status,'DRAFT');
});
test('expired quotes and untrusted origins cannot advance the workflow',async t=>{
  let now=100000;const workflow=new Workflow({clock:()=>now});const app=await fixture(t,{workflow});assert.equal((await post(app,'/api/assess',{requests:SAMPLE},'https://evil.example.test')).status,403);
  const assessment=(await post(app,'/api/assess',{requests:SAMPLE})).data;const quote=(await post(app,'/api/quote',{assessmentId:assessment.id,selectedIds:['R1'],rateCents:5000})).data;now+=1800001;assert.equal((await post(app,'/api/approve',{quoteId:quote.id,fingerprint:quote.fingerprint})).status,409);
});
