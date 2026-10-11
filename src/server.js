import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {loadEnvFile} from 'node:process';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Problem,Workflow,SCOPE,SAMPLE,groundAssessment,invoicePayload,validateRequests,verifyInvoiceTotal} from './domain.js';
import {ScopeAssistant,PayPalSandbox} from './providers.js';
import {ChatGPTPlanConnection,ChatGPTPlanAssistant} from './chatgpt-plan.js';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const STATIC={'/':['index.html','text/html'],'/style.css':['style.css','text/css'],'/app.js':['app.js','text/javascript'],'/favicon.ico':['favicon.svg','image/svg+xml']};
async function body(request){
  if(!request.headers['content-type']?.startsWith('application/json'))throw new Problem('Use application/json.',415);
  const chunks=[];let bytes=0;
  for await(const chunk of request){bytes+=chunk.length;if(bytes>24000)throw new Problem('Request is too large.',413);chunks.push(chunk);}
  // A UTF-8 character may span network chunks. Decode once after enforcing
  // the byte limit so the request and its scope evidence remain unchanged.
  try{const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}catch{throw new Problem('Provide a JSON object encoded as valid UTF-8.');}
}
export async function startServer({port=4185,assistant=new ScopeAssistant(),paypal=new PayPalSandbox(),workflow=new Workflow(),planConnection=null,planInitializationError=null}={}){
  const localAssistant=new ScopeAssistant();
  const planAssistant=planConnection?new ChatGPTPlanAssistant({connection:planConnection}):null;
  const planStatus=()=>planAssistant?{available:true,...planAssistant.status()}:{available:false,connected:false,explanation:planInitializationError||'ChatGPT plan connection is unavailable in this server.'};
  const server=http.createServer(async(request,response)=>{
    const send=(status,data,type='application/json')=>{response.writeHead(status,{'Content-Type':`${type}; charset=utf-8`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"});response.end(Buffer.isBuffer(data)?data:JSON.stringify(data));};
    try{
      const address=server.address();const allowed=[`127.0.0.1:${address.port}`,`localhost:${address.port}`];
      if(!allowed.includes(request.headers.host)||request.headers.origin&&!allowed.some(host=>request.headers.origin===`http://${host}`))throw new Problem('Untrusted origin or host.',403);
      const path=new URL(request.url,`http://${allowed[0]}`).pathname;
      if(request.method==='GET'&&STATIC[path]){const[file,type]=STATIC[path];return send(200,await readFile(resolve(ROOT,'public',file)),type);}
      if(request.method==='GET'&&path==='/api/config')return send(200,{scope:SCOPE,sample:SAMPLE,aiConfigured:Boolean(assistant.configured??assistant.key),nebiusConfigured:Boolean(assistant.configured??assistant.key),chatgptPlan:planStatus(),paypalConfigured:paypal.configured,provider:'Local rules available · choose a source before assessing',paymentMode:'Sandbox only · no invoice sending or live payments'});
      if(request.method==='GET'&&path==='/api/chatgpt/status')return send(200,planStatus());
      if(request.method==='GET'&&path==='/api/chatgpt/models'){
        if(!planConnection)throw new Problem('ChatGPT plan connection is unavailable in this server.',503);
        return send(200,await planConnection.listModels());
      }
      if(request.method!=='POST')throw new Problem('Not found.',404);
      const data=await body(request);
      if(path.startsWith('/api/chatgpt/')){
        if(!planConnection)throw new Problem('ChatGPT plan connection is unavailable in this server.',503);
        if(path==='/api/chatgpt/connect')return send(200,await planConnection.startSignIn({accountId:data.accountId}));
        if(path==='/api/chatgpt/cancel'){await planConnection.cancelSignIn();return send(200,planStatus());}
        if(path==='/api/chatgpt/model'){await planConnection.selectModel(data.model);return send(200,planStatus());}
        if(path==='/api/chatgpt/account'){await planConnection.selectAccount(data.accountId);return send(200,planStatus());}
        if(path==='/api/chatgpt/disconnect'){const result=await planConnection.disconnect();return send(200,{...planStatus(),remoteRevocationConfirmed:result.remoteRevocationConfirmed,message:result.message});}
        throw new Problem('Not found.',404);
      }
      if(path==='/api/assess'){
        const sources={local:localAssistant,nebius:assistant,'chatgpt-plan':planAssistant};
        if(data.aiMode!==undefined&&!Object.hasOwn(sources,data.aiMode))throw new Problem('Choose a supported assessment source.');
        const selected=data.aiMode===undefined?assistant:sources[data.aiMode];
        if(!selected)throw new Problem('Connect your ChatGPT plan and choose an available model first.',503);
        if(data.aiMode==='nebius'&&!assistant.configured)throw new Problem('Configure an available Nebius model before choosing this source.',503);
        const requests=validateRequests(data.requests);const result=await selected.assess(requests);const items=groundAssessment(requests,result.assessments);
        const provenance=result.provenance??(result.aiUsed?{requestedModel:result.requestedModel??null,returnedModel:result.model??null,modelMatchesRequested:result.modelMatchesRequested??null,responseId:result.responseId??null}:null);
        return send(200,workflow.retain({id:randomUUID(),createdAt:workflow.clock(),items,provider:result.provider,aiUsed:result.aiUsed,model:result.model,...(provenance?{provenance}:{})}));
      }
      if(path==='/api/quote')return send(200,workflow.preview(data));
      if(path==='/api/approve')return send(200,workflow.approve(data.quoteId,data.fingerprint));
      if(path==='/api/invoice'){
        const quote=workflow.quote(data.quoteId);if(quote.status!=='approved')throw new Problem('Review and approve this quote first.',409);
        if(quote.creationUncertain)throw new Problem('A previous creation request may have reached PayPal. Check the sandbox dashboard for this quote reference before making another quote; automatic creation retries are blocked.',409);
        if(quote.inFlight)throw new Problem('This invoice request is already running.',409);
        const payload=invoicePayload(quote,data.sandboxBuyerEmail);
        quote.invoiceRequestId ||= randomUUID();
        // Preserve exact payload on retries so a different email cannot reuse the same request ID.
        if(quote.invoicePayload&&JSON.stringify(quote.invoicePayload)!==JSON.stringify(payload))throw new Problem('This quote already has a sandbox invoice attempt for another recipient. Prepare a new quote.',409);
        if(quote.invoice){
          try{quote.invoice=verifyInvoiceTotal(quote,await paypal.details(quote.invoice.id));return send(200,quote.invoice);}
          catch(error){quote.invoice={id:quote.invoice.id,status:'STATUS_UNVERIFIED',source:'PayPal sandbox'};error.invoice=quote.invoice;throw error;}
        }
        quote.invoicePayload ||= payload;quote.inFlight=true;
        try{
          quote.invoice=await paypal.createDraft(payload,quote.invoiceRequestId);
          quote.invoice=verifyInvoiceTotal(quote,await paypal.details(quote.invoice.id));
          return send(200,quote.invoice);
        }catch(error){
          if(error.creationMayExist)quote.creationUncertain=true;
          if(quote.invoice)error.invoice=quote.invoice;
          throw error;
        }finally{quote.inFlight=false;}
      }
      if(path==='/api/invoice-status'){
        const quote=workflow.quote(data.quoteId);if(!quote.invoice)throw new Problem('Create a sandbox draft invoice first.',409);
        try{const details=verifyInvoiceTotal(quote,await paypal.details(quote.invoice.id));quote.invoice=details;return send(200,details);}
        catch(error){quote.invoice={id:quote.invoice.id,status:'STATUS_UNVERIFIED',source:'PayPal sandbox'};error.invoice=quote.invoice;throw error;}
      }
      throw new Problem('Not found.',404);
    }catch(error){send(error instanceof Problem?error.status:500,{error:error instanceof Problem?error.message:'The request could not finish.',...(error.invoice?{invoice:error.invoice}:{})});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{loadEnvFile(resolve(ROOT,'.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let planConnection=null,planInitializationError=null;
  try{planConnection=await ChatGPTPlanConnection.create();}catch(error){planInitializationError=error instanceof Problem?error.message:'Protected ChatGPT sign-in storage could not be initialized.';console.log(`ChatGPT plan setup unavailable: ${planInitializationError}`);}
  const running=await startServer({port:Number(process.env.PORT||4185),assistant:new ScopeAssistant({key:process.env.NEBIUS_API_KEY,model:process.env.NEBIUS_MODEL}),paypal:new PayPalSandbox({clientId:process.env.PAYPAL_SANDBOX_CLIENT_ID,secret:process.env.PAYPAL_SANDBOX_SECRET}),planConnection,planInitializationError});
  console.log(`ScopeGuard: ${running.url}`);console.log('PayPal sandbox only. AI and sandbox access require separate configuration.');
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await running.close();await planConnection?.close();process.exit(0);});
}
