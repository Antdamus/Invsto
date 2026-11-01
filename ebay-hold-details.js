/* Display eBay's saved explanations verbatim. A hold is not a refund or an unpaid buyer. */
(function(root){
 'use strict';
 const labels={delivery:'Waiting for delivery',authentication:'Waiting for authentication',return:'Open return',request:'Open buyer request',dispute:'Dispute / claim',scheduled:'Estimated release date · reason not provided',releasing:'Release in progress',other:'Other eBay explanation',unknown:'Reason not provided'};
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const array=a=>Array.isArray(a)?a:[],text=s=>typeof s==='string'?s.trim():'';
 const stamp=s=>Number.isFinite(Date.parse(s))?new Date(s).toLocaleString('en-US',{timeZone:'America/New_York',year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'';
 function category(memo){
  const s=text(memo).toLowerCase();
  if(!s||/^(funds? (on )?hold|on hold|held)[.!]?$/.test(s))return 'unknown';
  if(/\bopen return\b/.test(s))return 'return';
  if(/\bopen request\b/.test(s))return 'request';
  if(/\b(dispute|claim|chargeback)\b/.test(s))return 'dispute';
  if(/\bauthentication\b/.test(s))return 'authentication';
  if(/\bdelivery\b/.test(s))return 'delivery';
  if(/\bestimated release\b/.test(s))return 'scheduled';
  if(/\brelease in progress\b/.test(s))return 'releasing';
  return 'other';
 }
 function model(id,evidence={},held){
  const finance=evidence.finance||{},transactions=array(finance.transactions).filter(t=>t.transactionType==='SALE'&&t.bookingEntry==='CREDIT'&&t.transactionStatus!=='FAILED'&&
   (t.orderNumber===id||(!t.orderNumber&&finance.orderNumber===id&&finance.source==='ebay_finances_api')));
  const onHold=transactions.filter(t=>t.transactionStatus==='FUNDS_ON_HOLD');
  const holds=array(evidence.payments).flatMap(p=>array(p.paymentHolds)).filter(h=>h.holdState==='HELD');
  if(held===false||held!==true&&!(transactions.length?onHold.length:holds.length))return null;
  const memos=[...new Set(onHold.map(t=>text(t.memo)).filter(Boolean))];
  const categories=[...new Set((memos.length?memos:['']).map(category))];
  // Do not decode undocumented provider codes or use releaseDate as proof of release.
  const codes=[...new Set(holds.map(h=>text(h.holdReason)).filter(Boolean))];
  const estimates=[...new Set(holds.map(h=>text(h.expectedReleaseDate)).filter(d=>stamp(d)))];
  const actions=[...new Set(holds.flatMap(h=>array(h.sellerActionsToRelease)).map(a=>text(a.sellerActionToRelease)).filter(Boolean))];
  return {id,memos,categories,codes,estimates,actions,checked:onHold.length?finance.syncedAt:null,modified:evidence.modified,source:onHold.length?'eBay payments':'Saved eBay order',
   releaseObserved:transactions.length>0&&transactions.every(t=>['FUNDS_AVAILABLE_FOR_PAYOUT','PAYOUT_INITIATED','PAYOUT','PAID_OUT'].includes(t.transactionStatus)),financeChecked:finance.syncedAt};
 }
 function fromLine(line){
  const order=line?.order||line||{},raw=order.raw_payload||{},lineRaw=line?.raw_payload||{};
  const candidates=[raw.ebayFinance,lineRaw.ebayFinance,order.ebay_finance,line?.ebay_finance].filter(f=>f&&typeof f==='object');
  candidates.sort((a,b)=>(Date.parse(b.syncedAt)||0)-(Date.parse(a.syncedAt)||0));
  return model(order.order_number,{finance:candidates[0],payments:raw.order?.paymentSummary?.payments,modified:raw.order?.lastModifiedDate});
 }
 function render(m,{compact=false}={}){
  if(!m)return '';
  if(m.snapshot&&m.releaseObserved&&Date.parse(m.financeChecked)>Date.parse(m.snapshot))return '<aside class="ebay-hold-detail" aria-label="eBay hold update"><strong class="eh-heading">Payment record changed after this held-list snapshot</strong><p class="eh-explanation">A newer eBay payment record reports these sale funds released. Refresh hold details to verify the account list.</p><small class="eh-source">eBay payments · '+esc(stamp(m.financeChecked))+'</small></aside>';
  const quote=m.memos.length?m.memos.map(s=>'<p class="eh-explanation">'+esc(s)+'</p>').join(''):'<p class="eh-explanation">eBay has not provided a specific hold explanation in the saved records.</p>';
  const unknown=m.categories.includes('unknown')&&m.memos.length?'<p class="eh-muted">This confirms a hold but does not explain its cause.</p>':'';
  const details=m.estimates.length||m.actions.length||m.codes.length;
  return '<aside class="ebay-hold-detail'+(compact?' eh-compact':'')+'" aria-label="eBay hold explanation"><strong class="eh-heading">'+(compact?'Funds on hold · ':'Why eBay is holding the funds · ')+esc(m.categories.map(k=>labels[k]).join(' / '))+'</strong>'+quote+unknown+
   '<small class="eh-source">'+esc(m.source)+(stamp(m.checked)?' · Checked '+esc(stamp(m.checked)):stamp(m.modified)?' · Last modified '+esc(stamp(m.modified)):'')+'</small>'+
   (details?'<details><summary>Release estimate &amp; eBay details</summary>'+
    m.estimates.map(d=>'<p><b>Saved order release estimate:</b> '+esc(stamp(d))+(Date.parse(d)<Date.now()?' · Estimate has passed':'')+'</p>').join('')+
    (m.estimates.length?'<p class="eh-muted">Estimate from the saved order record'+(stamp(m.modified)?' (order last modified '+esc(stamp(m.modified))+')':'')+'. It may predate the payment explanation above; eBay has not guaranteed this release date.</p>':'<p class="eh-muted">No release date was supplied in the saved order record.</p>')+
    m.actions.map(a=>'<p><b>eBay seller action:</b> '+esc(a)+'</p>').join('')+
    (m.codes.length?'<p class="eh-muted">eBay hold code: '+esc(m.codes.join(', '))+'. Shown as supplied; no cause inferred from this code.</p>':'')+'</details>':'')+
   (/^\d{2}-\d{5}-\d{5}$/.test(m.id)?'<a href="https://www.ebay.com/mesh/ord/details?orderid='+encodeURIComponent(m.id)+'" target="_blank" rel="noopener">Check this order on eBay ↗</a>':'')+'</aside>';
 }
 const matches=(m,value)=>value==='all'||Boolean(m)&&(value==='held'||m.categories.includes(value));
 const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 function memoDate(memo){
  const hit=text(memo).match(/\bestimated release(?:\s+(?:on|date(?: is)?))?\s*:?\s+([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i);
  if(!hit)return null;
  const month=months.findIndex(m=>m.toLowerCase()===hit[1].slice(0,3).toLowerCase()),day=Number(hit[2]),year=hit[3]?Number(hit[3]):null;
  if(month<0||day<1||day>new Date(Date.UTC(year??2000,month+1,0)).getUTCDate())return null;
  const md=String(month+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
  // The payment memo often omits a year and timezone. Preserve that uncertainty;
  // neither today's year nor an older order estimate can supply those facts.
  return {key:year?'day:'+year+'-'+md:'month-day:'+md,label:months[month]+' '+day+(year?', '+year:' · year not supplied'),source:'eBay payment message',sort:year?'1:'+year+'-'+md:'0:'+md};
 }
 function releaseDates(m){
  if(!m||m.snapshot&&m.releaseObserved&&Date.parse(m.financeChecked)>Date.parse(m.snapshot))return [];
  const scheduled=m.memos.filter(s=>category(s)==='scheduled'),parsed=scheduled.map(memoDate).filter(Boolean);
  if(scheduled.length)return [...new Map(parsed.map(d=>[d.key,d])).values()];
  // A saved order estimate is a fallback only when the payment message has no dated estimate.
  return [...new Map(m.estimates.map(s=>{
   const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(s));
   const part=k=>parts.find(p=>p.type===k)?.value,md=part('month')+'-'+part('day'),year=part('year');
   return {key:'day:'+year+'-'+md,label:months[Number(part('month'))-1]+' '+Number(part('day'))+', '+year,source:'Saved order estimate · Eastern',sort:'1:'+year+'-'+md};
  }).map(d=>[d.key,d])).values()];
 }
 const matchesDate=(m,value)=>value==='all'||Boolean(m)&&(value==='undated'?releaseDates(m).length===0:releaseDates(m).some(d=>d.key===value));
 function dateOptions(models,value='all'){
  const rows=models.filter(Boolean),dates=new Map();let undated=0;
  for(const m of rows){const found=releaseDates(m);if(!found.length)undated++;for(const d of found){const prior=dates.get(d.key);dates.set(d.key,{...d,count:(prior?.count||0)+1});}}
  if(value!=='all'&&value!=='undated'&&!dates.has(value)){
   const memo=value.startsWith('month-day:')?value.slice(10):value.startsWith('day:')?value.slice(9):'';
   const y=value.startsWith('day:')?value.slice(4,8):'';
   if(/^\d{2}-\d{2}$/.test(memo))dates.set(value,{key:value,label:months[Number(memo.slice(0,2))-1]+' '+Number(memo.slice(3))+(y?', '+y:' · year not supplied'),sort:y?'1:'+y+'-'+memo:'0:'+memo,count:0});
  }
  return '<option value="all">All estimated dates</option>'+[...dates.values()].sort((a,b)=>a.sort.localeCompare(b.sort)).map(d=>'<option value="'+esc(d.key)+'">'+esc(d.label)+' · '+d.count+'</option>').join('')+
   (undated||value==='undated'?'<option value="undated">No dated estimate available · '+undated+'</option>':'');
 }
 function options(models,value='all',unit='orders'){
  const rows=models.filter(Boolean),count=k=>rows.filter(m=>m.categories.includes(k)).length;
  return '<option value="all">All '+esc(unit)+'</option><option value="held">All on hold · '+rows.length+'</option>'+Object.entries(labels).filter(([k])=>count(k)||k===value).map(([k,v])=>'<option value="'+k+'">'+esc(v)+' · '+count(k)+'</option>').join('');
 }
 root.OGEbayHoldDetails={model,fromLine,render,category,labels,matches,options,releaseDates,matchesDate,dateOptions};
})(typeof window==='undefined'?globalThis:window);
