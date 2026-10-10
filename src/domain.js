import { createHash, randomUUID } from 'node:crypto';
export class Problem extends Error { constructor(message,status=400){super(message);this.status=status;} }
export const SCOPE = [
  {id:'C1',text:'Deliver one marketing landing page, including headline, copy, colours and typography.'},
  {id:'C2',text:'Include three initial design options and two rounds of revisions to the agreed landing page.'},
  {id:'C3',text:'Additional pages and third-party integrations are outside the agreed scope and need a separate estimate.'},
  {id:'C4',text:'Additional work starts only after the client approves a written change order with itemized pricing.'},
];
export const SAMPLE = [
  {id:'R1',title:'Add a separate FAQ page',details:'Please add another page with a searchable FAQ.',hours:4},
  {id:'R2',title:'Connect a booking service',details:'Integrate a third-party booking API into the site.',hours:6},
  {id:'R3',title:'Adjust the headline colour',details:'Please change the headline colour during our first revision round.',hours:1},
];
export function digest(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function validateRequests(requests){
  if(!Array.isArray(requests)||requests.length<1||requests.length>12)throw new Problem('Provide between 1 and 12 requests.');
  const ids=new Set();
  return requests.map((item,index)=>{
    if(!item||typeof item!=='object')throw new Problem('Each request needs a title and details.');
    const id=typeof item.id==='string'?item.id:`R${index+1}`;
    if(!/^[A-Za-z0-9_-]{1,30}$/.test(id)||ids.has(id))throw new Problem('Request IDs must be unique and simple.');ids.add(id);
    if(typeof item.title!=='string'||item.title.trim().length<3||item.title.length>140||typeof item.details!=='string'||item.details.trim().length<3||item.details.length>1500)throw new Problem('Request titles need 3–140 characters and details need 3–1500.');
    if(!Number.isFinite(item.hours)||item.hours<=0||item.hours>100||!Number.isInteger(item.hours*4))throw new Problem('Estimate hours in quarter-hour increments, up to 100 per request.');
    return {id,title:item.title.trim(),details:item.details.trim(),hours:item.hours};
  });
}
export function offlineAssess(requests){
  return requests.map(item=>{
    const text=`${item.title} ${item.details}`;
    if(/\b(additional|another|separate|extra|second|new)\b.*\bpage\b|\bintegrat(?:e|ion|ions)\b|\bthird[- ]party\b|\bAPI\b|\bcheckout\b/i.test(text))return {requestId:item.id,classification:'change_order',clauseIds:['C3','C4'],reason:'This request introduces a separate page or integration. Review an estimate under C3 and obtain written approval under C4.'};
    if(/\b(?:third|fourth|extra)\b.*\brevision\b/i.test(text))return {requestId:item.id,classification:'needs_review',clauseIds:['C2','C4'],reason:'The revision limit may be exceeded. Confirm the completed revision count before estimating.'};
    if(/\bheadline|\bcopy\b|colou?r|typography|\bfont\b/i.test(text))return {requestId:item.id,classification:'included',clauseIds:['C1','C2'],reason:'This appears to be a landing-page detail. Confirm it is within the two agreed revision rounds.'};
    return {requestId:item.id,classification:'needs_review',clauseIds:['C4'],reason:'The local rules cannot establish whether this request is included. Review the agreement with the client.'};
  });
}
export function groundAssessment(requests, assessments){
  if(!Array.isArray(assessments)||assessments.length!==requests.length)throw new Problem('The assistant did not assess every request.',502);
  const seen=new Set();
  const grounded=assessments.map(item=>{
    const request=requests.find(request=>request.id===item?.requestId);
    if(!request||seen.has(item.requestId)||!['included','change_order','needs_review'].includes(item.classification)||typeof item.reason!=='string'||item.reason.length<5||item.reason.length>1200||!Array.isArray(item.clauseIds)||item.clauseIds.length<1||item.clauseIds.some(id=>!SCOPE.some(clause=>clause.id===id)))throw new Problem('The assistant returned unsupported scope evidence. No quote was created.',502);
    seen.add(item.requestId);
    return {...request,classification:item.classification,reason:item.reason,clauses:[...new Set(item.clauseIds)].map(id=>SCOPE.find(clause=>clause.id===id))};
  });
  return requests.map(request=>grounded.find(item=>item.id===request.id));
}
export class Workflow {
  constructor({clock=()=>Date.now()}={}){this.clock=clock;this.assessments=new Map();this.quotes=new Map();}
  retain(assessment){this.assessments.set(assessment.id,assessment);return assessment;}
  assessment(id){const found=this.assessments.get(id);if(!found||this.clock()-found.createdAt>3600000)throw new Problem('This assessment expired. Assess the requests again.',409);return found;}
  preview({assessmentId,selectedIds,rateCents}){
    const assessment=this.assessment(assessmentId);
    if(!Number.isInteger(rateCents)||rateCents<100||rateCents>1000000)throw new Problem('Hourly rate must be $1–$10,000 in whole cents.');
    if(!Array.isArray(selectedIds)||!selectedIds.length||new Set(selectedIds).size!==selectedIds.length)throw new Problem('Select at least one distinct change-order item.');
    const items=selectedIds.map(id=>{const item=assessment.items.find(item=>item.id===id);if(!item||item.classification!=='change_order')throw new Problem('Only reviewed change-order suggestions can be quoted.');return {requestId:item.id,name:item.title,hours:item.hours,unitCents:rateCents,lineCents:Math.round(item.hours*rateCents),clauseIds:item.clauses.map(clause=>clause.id)};});
    const quote={id:randomUUID(),assessmentId,items,currency:'USD',totalCents:items.reduce((sum,item)=>sum+item.lineCents,0),createdAt:this.clock(),status:'preview'};
    if(quote.totalCents>100000000)throw new Problem('Quote exceeds the prototype maximum.');
    quote.fingerprint=digest({items,currency:quote.currency,totalCents:quote.totalCents});this.quotes.set(quote.id,quote);return structuredClone(quote);
  }
  quote(id){const quote=this.quotes.get(id);if(!quote||this.clock()-quote.createdAt>1800000)throw new Problem('This quote expired. Prepare and review a fresh preview.',409);return quote;}
  approve(id,fingerprint){const quote=this.quote(id);if(quote.fingerprint!==fingerprint)throw new Problem('Review the current quote before approving it.',409);if(quote.status==='preview')quote.status='approved';return structuredClone(quote);}
}
export function invoicePayload(quote,email){
  if(quote.status!=='approved')throw new Problem('Approve the itemized quote first.',409);
  if(typeof email!=='string'||email.length>180||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Problem('Provide your sandbox buyer account email.');
  return {
    detail:{currency_code:'USD',reference:quote.id,note:`ScopeGuard change order ${quote.id}. Scope references: ${[...new Set(quote.items.flatMap(item=>item.clauseIds))].join(', ')}.`},
    primary_recipients:[{billing_info:{email_address:email}}],
    items:quote.items.map(item=>({name:item.name,description:`${item.hours} hours × $${(item.unitCents/100).toFixed(2)}. References ${item.clauseIds.join(', ')}.`,quantity:'1',unit_amount:{currency_code:'USD',value:(item.lineCents/100).toFixed(2)}})),
    configuration:{allow_tip:false,partial_payment:{allow_partial_payment:false}},
  };
}
export function verifyInvoiceTotal(quote,invoice){
  if(invoice.amount?.currency_code!=='USD'||!/^\d+(?:\.\d{1,2})?$/.test(invoice.amount?.value||'')||Math.round(Number(invoice.amount.value)*100)!==quote.totalCents)throw new Problem('Sandbox invoice total differs from the approved quote or is unavailable. Review the actual invoice in the sandbox dashboard.',502);
  return invoice;
}
