import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../src/server.js';
import {ScopeAssistant} from '../src/providers.js';
import {ChatGPTPlanConnection} from '../src/chatgpt-plan.js';
import {SAMPLE,offlineAssess,Problem} from '../src/domain.js';

async function post(app,path,data,origin){const response=await fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(data)});return {status:response.status,data:await response.json()};}
async function server(t,options){const app=await startServer({port:0,...options});t.after(()=>app.close());return app;}

test('explicit local mode never uses a configured paid provider; unsupported sources fail',async t=>{
  let calls=0;const assistant={configured:true,async assess(){calls++;throw new Error('Provider must not run');}};
  const app=await server(t,{assistant});
  const result=await post(app,'/api/assess',{aiMode:'local',requests:SAMPLE});
  assert.equal(result.status,200);assert.equal(result.data.aiUsed,false);assert.equal(calls,0);
  assert.equal((await post(app,'/api/assess',{aiMode:'unsupported',requests:SAMPLE})).status,400);
  assert.equal((await post(app,'/api/assess',{aiMode:'chatgpt-plan',requests:SAMPLE})).status,503);
  assert.equal(calls,0);
});

test('unknown provider metadata remains unverified rather than reusing the requested model name',async()=>{
  const assistant=new ScopeAssistant({key:'stub',model:'requested-model',fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({assessments:offlineAssess(SAMPLE)})}}]}),{headers:{'Content-Type':'application/json'}})});
  const result=await assistant.assess(SAMPLE);
  assert.equal(result.model,null);assert.equal(result.provenance.requestedModel,'requested-model');assert.equal(result.provenance.modelIdentityVerified,false);
});

const nebiusResponse=()=>new Response(JSON.stringify({model:'requested-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify({assessments:offlineAssess(SAMPLE)})}}]}),{headers:{'Content-Type':'application/json'}});

test('Nebius dispatches are serialized and concurrent refusals do not spend the bounded budget',{timeout:5000},async t=>{
  let release;const held=new Promise(resolve=>{release=resolve;});let calls=0;
  t.after(()=>release());
  const assistant=new ScopeAssistant({key:'stub',model:'requested-model',maxCalls:2,fetchImpl:async(url,options)=>{calls++;assert.equal(options.redirect,'error');await held;return nebiusResponse();}});
  const pending=assistant.assess(SAMPLE);
  assert.deepEqual(assistant.status(),{configured:true,attemptedCalls:1,callLimit:2,callsRemaining:1,inFlight:true});
  await assert.rejects(assistant.assess(SAMPLE),error=>error instanceof Problem&&error.status===409);
  assert.equal(calls,1);assert.equal(assistant.attemptedCalls,1);
  release();assert.equal((await pending).aiUsed,true);
  assert.equal(assistant.status().inFlight,false);
  assert.equal((await assistant.assess(SAMPLE)).aiUsed,true);
  await assert.rejects(assistant.assess(SAMPLE),error=>error instanceof Problem&&error.status===503);
  assert.equal(calls,2);assert.equal(assistant.callsRemaining,0);
});

test('failed and aborted Nebius dispatches consume calls without leaking provider diagnostics',async()=>{
  let calls=0;
  const assistant=new ScopeAssistant({key:'private-stub-key',model:'requested-model',maxCalls:2,fetchImpl:async()=>{calls++;if(calls===1)return new Response('private-stub-key',{status:403});throw new DOMException('private-stub-key','AbortError');}});
  for(let i=0;i<2;i++)await assert.rejects(assistant.assess(SAMPLE),error=>error instanceof Problem&&error.status===502&&!error.message.includes('private-stub-key'));
  assert.equal(assistant.attemptedCalls,2);assert.equal(assistant.status().inFlight,false);
  await assert.rejects(assistant.assess(SAMPLE),error=>error.status===503);
  assert.equal(calls,2);
});

test('Nebius configuration failures and local mode never consume inference attempts',async()=>{
  let calls=0;const forbiddenFetch=()=>{calls++;throw new Error('No dispatch permitted');};
  const incomplete=new ScopeAssistant({key:'stub',maxCalls:1,fetchImpl:forbiddenFetch});
  await assert.rejects(incomplete.assess(SAMPLE),error=>error.status===503);
  assert.equal(incomplete.attemptedCalls,0);
  const local=new ScopeAssistant({maxCalls:1,fetchImpl:forbiddenFetch});
  assert.equal((await local.assess(SAMPLE)).aiUsed,false);assert.equal((await local.assess(SAMPLE)).aiUsed,false);
  assert.equal(local.attemptedCalls,0);assert.equal(calls,0);
  for(const maxCalls of [0,51,1.5,NaN])assert.throws(()=>new ScopeAssistant({maxCalls}),Problem);
});

test('filtered, unfinished and malformed Nebius assessments cannot be accepted as AI results',async()=>{
  let payload;
  const assistant=new ScopeAssistant({key:'stub',model:'requested-model',maxCalls:10,fetchImpl:async()=>new Response(JSON.stringify(payload))});
  for(const reason of ['length','content_filter','tool_calls',null,undefined]){
    payload={model:'requested-model',choices:[{finish_reason:reason,message:{content:JSON.stringify({assessments:offlineAssess(SAMPLE)})}}]};
    await assert.rejects(assistant.assess(SAMPLE),error=>error instanceof Problem&&error.status===502);
  }
  for(const malformed of [null,{choices:[{finish_reason:'stop',message:{content:'null'}}]},{choices:[{finish_reason:'stop',message:{content:'{"assessments":[]}'}}]}]){
    payload=malformed;await assert.rejects(assistant.assess(SAMPLE),error=>error instanceof Problem&&error.status===502);
  }
  assert.equal(assistant.attemptedCalls,8);assert.equal(assistant.status().inFlight,false);
});

test('provider byte limit cancels the response before reading the remaining oversized stream',async()=>{
  let reads=0,cancelled=false;
  const body=new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(reads===1?150001:1));},cancel(){cancelled=true;}},{highWaterMark:0});
  const assistant=new ScopeAssistant({key:'stub',model:'requested-model',fetchImpl:async()=>new Response(body)});
  await assert.rejects(assistant.assess(SAMPLE),error=>error instanceof Problem&&error.status===502&&/exceeded/.test(error.message));
  assert.equal(reads,1);assert.equal(cancelled,true);assert.equal(assistant.attemptedCalls,1);assert.equal(assistant.status().inFlight,false);
});

test('exhausting configured Nebius access keeps explicit local assessment available through the API',async t=>{
  let calls=0;const assistant=new ScopeAssistant({key:'stub',model:'requested-model',maxCalls:1,fetchImpl:async()=>{calls++;return new Response('private diagnostic',{status:403});}});
  const app=await server(t,{assistant});
  assert.equal((await post(app,'/api/assess',{aiMode:'nebius',requests:SAMPLE})).status,502);
  assert.equal((await post(app,'/api/assess',{aiMode:'nebius',requests:SAMPLE})).status,503);
  const local=await post(app,'/api/assess',{aiMode:'local',requests:SAMPLE});
  assert.equal(local.status,200);assert.equal(local.data.aiUsed,false);assert.equal(calls,1);
  const config=await (await fetch(app.url+'/api/config')).json();
  assert.deepEqual(config.nebiusStatus,{configured:true,attemptedCalls:1,callLimit:1,callsRemaining:0,inFlight:false});
});

test('configuration exports only safe optional provider budget fields',async t=>{
  const assistant={configured:true,status:()=>({attemptedCalls:0,callLimit:10,callsRemaining:10,inFlight:false,key:'private-stub-key',headers:{Authorization:'private-stub-key'}})};
  const app=await server(t,{assistant});const config=await (await fetch(app.url+'/api/config')).json();
  assert.deepEqual(config.nebiusStatus,{configured:true,attemptedCalls:0,callLimit:10,callsRemaining:10,inFlight:false});
  assert.doesNotMatch(JSON.stringify(config),/private-stub-key|Authorization/);
});

test('HTTP sign-in recovery reuses the selected issued registration and can cancel a pending callback',async t=>{
  let received,pending=false;const connection={
    status:()=>({connected:false,sharing:false,selectedModel:null,accounts:[{accountId:'oaiapp_stub',label:'Saved sign-in',validated:false}],signInPending:pending}),
    startSignIn:async options=>{received=options;pending=true;return {authorizationUrl:'https://auth.openai.com/api/accounts/authorize'};},
    cancelSignIn:()=>{pending=false;},
  };
  Object.setPrototypeOf(connection,ChatGPTPlanConnection.prototype);
  const app=await server(t,{planConnection:connection});
  assert.equal((await post(app,'/api/chatgpt/connect',{accountId:'oaiapp_stub'})).status,200);
  assert.equal(received.accountId,'oaiapp_stub');
  assert.equal((await (await fetch(app.url+'/api/chatgpt/status')).json()).signInPending,true);
  assert.equal((await post(app,'/api/chatgpt/cancel',{})).data.signInPending,false);
  assert.equal((await post(app,'/api/chatgpt/cancel',{},'https://untrusted.example')).status,403);
});

test('ChatGPT HTTP routes select an account-returned model and preserve completed inference provenance',async t=>{
  let sharing=true,selectedModel=null,calls=0;
  const connection={
    status:()=>({connected:sharing,sharing,selectedModel,activeAccountId:sharing?'stub-account':null,accounts:[],lastSignInError:null}),
    listModels:async()=>[{slug:'account-model',displayName:'Account model'}],
    availableModels:async()=>[{slug:'account-model',displayName:'Account model'}],
    selectModel:async model=>{if(model!=='account-model')throw new Problem('Choose an account model.',400);selectedModel=model;},
    startSignIn:async()=>({authorizationUrl:'https://auth.openai.com/authorize?state=stub-state',redirectUri:'http://127.0.0.1:40000/auth/callback',expiresAt:Date.now()+60000}),
    disconnect:async()=>{sharing=false;selectedModel=null;return {remoteRevocationConfirmed:false,message:'Disconnected locally.'};},
    apiRequest:async(url,options,consume,timeout,onDispatch)=>{
      onDispatch?.('stub-account');calls++;const body=JSON.parse(options.body);assert.equal(body.model,'account-model');assert.equal(body.store,false);assert.equal(body.stream,true);
      const text=JSON.stringify({assessments:offlineAssess(SAMPLE)});
      const event={type:'response.completed',response:{id:'resp-stub',status:'completed',model:'account-model',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}};
      return consume(new Response(`data: ${JSON.stringify(event)}\n\n`,{headers:{'Content-Type':'text/event-stream'}}),'stub-account');
    },
  };
  Object.setPrototypeOf(connection,ChatGPTPlanConnection.prototype);
  const app=await server(t,{planConnection:connection});
  const config=await (await fetch(app.url+'/api/config')).json();assert.equal(config.chatgptPlan.verifiedInferenceCalls,0);assert.ok(!JSON.stringify(config).includes('accessToken'));
  assert.equal((await post(app,'/api/chatgpt/model',{model:'invented-model'})).status,400);
  assert.equal((await post(app,'/api/assess',{aiMode:'chatgpt-plan',requests:SAMPLE})).status,503);
  assert.equal((await post(app,'/api/chatgpt/model',{model:'account-model'})).status,200);
  const assessment=await post(app,'/api/assess',{aiMode:'chatgpt-plan',requests:SAMPLE});
  assert.equal(assessment.status,200);assert.equal(assessment.data.aiUsed,true);assert.equal(assessment.data.provenance.responseId,'resp-stub');assert.equal(assessment.data.provenance.requestedModel,'account-model');assert.equal(assessment.data.provenance.modelMatchesRequested,true);assert.equal(calls,1);
  const status=await (await fetch(app.url+'/api/chatgpt/status')).json();assert.equal(status.verifiedInferenceCalls,1);assert.equal(status.attemptedCalls,1);
  assert.equal((await post(app,'/api/chatgpt/connect',{},'https://outside.example')).status,403);
  assert.equal((await post(app,'/api/chatgpt/disconnect',{})).data.connected,false);
  assert.equal((await post(app,'/api/assess',{aiMode:'chatgpt-plan',requests:SAMPLE})).status,503);
  assert.equal(calls,1);
});
