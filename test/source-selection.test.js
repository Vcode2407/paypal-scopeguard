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
