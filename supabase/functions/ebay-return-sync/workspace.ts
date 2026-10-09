// Bounded, resumable discovery + detail jobs. No refund/accept/close calls to eBay.
export const lanes = ['return','inquiry','case','payment_dispute'] as const;
export type Lane = typeof lanes[number];
type DB = any;
type Dependencies = {
 token:(scope?:string)=>Promise<string>;
 read:(token:string,path:string,payment?:boolean)=>Promise<any>;
 process:(db:DB,lane:Lane,summary:any,detail:any,files:any)=>Promise<void>;
};
export function externalId(row:any):string {
 return String(row?.paymentDisputeId||row?.returnId||row?.inquiryId||row?.caseId||row?.requestId||'');
}
export function detailPath(lane:Lane,id:string):string {
 const key=encodeURIComponent(id);
 return lane==='payment_dispute'?`/sell/fulfillment/v1/payment_dispute/${key}`
  :lane==='case'?`/post-order/v2/casemanagement/${key}`:`/post-order/v2/${lane}/${key}?fieldgroups=FULL`;
}
export function discoveryPath(lane:Lane,offset:number,cycle:string):string {
 const p=new URLSearchParams({limit:'100',offset:String(offset)});
 if(lane==='payment_dispute')return `/sell/fulfillment/v1/payment_dispute_summary?${p}`;
 if(lane==='case') {
  // eBay only accepts case search start dates within the last 18 months.
  p.set('case_creation_date_range_from',new Date(Date.parse(cycle)-540*86400000).toISOString());
  p.set('case_creation_date_range_to',cycle);
  return `/post-order/v2/casemanagement/search?${p}`;
 }
 // Include recently closed issues too; closure is established from a detail
 // response, never from absence on a page or a failed provider request.
 p.set('creation_date_range_from',new Date(Date.parse(cycle)-180*86400000).toISOString());
 p.set('creation_date_range_to',cycle);
 return `/post-order/v2/${lane}/search?${p}`;
}
export function pageRows(payload:any,lane:Lane):any[] {
 const value=lane==='payment_dispute'?payload.paymentDisputeSummaries
  :payload.members||payload.returnSummaries||payload.inquirySummaries||payload.cases;
 if(!Array.isArray(value)) {
  const total=pageTotal(payload,lane);
  if(total===0)return [];
  throw Error('eBay returned an unrecognized issue list; the previous snapshot was retained.');
 }
 return value;
}
export function pageTotal(payload:any,lane:Lane):number|null {
 // Post-Order's top-level `total` can describe only the current page.
 // Its documented paginationOutput is the authoritative result-set count.
 const raw=lane==='payment_dispute'?payload.total
  :payload.paginationOutput?.totalEntries??payload.totalEntries??payload.totalNumberOfCases??payload.totalNumberOfInquiries;
 if(raw==null)return null;
 const total=Number(raw);
 if(!Number.isSafeInteger(total)||total<0)throw Error('eBay returned invalid pagination; discovery will retry.');
 return total;
}
function checked(result:any){if(result.error)throw result.error;return result.data;}
const message=(error:any)=>String(error?.message||error||'Sync failed').replace(/Bearer\s+\S+/gi,'[redacted]').slice(0,500);
const iso=(delay=0)=>new Date(Date.now()+delay).toISOString();
async function fingerprint(row:any){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(row))))).map(n=>n.toString(16).padStart(2,'0')).join('');}

export async function queueRefresh(db:DB,caseId?:string){
 if(caseId){
  const row=checked(await db.from('ebay_return_cases').select('source_lane,ebay_return_id').eq('id',caseId).single());
  if(!row?.ebay_return_id)throw Error('This case has no eBay case ID. Link the correct case before refreshing.');
  checked(await db.from('ebay_issue_sync_jobs').upsert({lane:row.source_lane,external_id:row.ebay_return_id,summary:{},state:'queued',priority:-10,attempts:0,next_attempt_at:iso(),updated_at:iso()},{onConflict:'lane,external_id'}));
 }else checked(await db.from('ebay_issue_sync_lanes').update({next_run_at:iso()}).in('lane',[...lanes]));
}

export async function runWorker(db:DB,deps:Dependencies){
 const started=Date.now();
 let ordinaryToken:Promise<string>|undefined,paymentToken:Promise<string>|undefined;
 const token=(lane:Lane)=>lane==='payment_dispute'
  ?(paymentToken??=deps.token('https://api.ebay.com/oauth/api_scope/sell.payment.dispute'))
  :(ordinaryToken??=deps.token());
 // One discovery page per invocation keeps discovery independent of a backlog.
 const laneRow=checked(await db.from('ebay_issue_sync_lanes').select('*').lte('next_run_at',iso()).order('next_run_at').limit(1).maybeSingle());
 if(laneRow){
  const lane=laneRow.lane as Lane,cycle=laneRow.cycle_started_at||iso();
  try{
   const payload=await deps.read(await token(lane),discoveryPath(lane,laneRow.cursor_offset,cycle),lane==='payment_dispute');
   const rows=pageRows(payload,lane);
   if(rows.some(r=>!externalId(r)))throw Error('An eBay issue is missing its identity. Discovery was stopped safely.');
   const total=pageTotal(payload,lane);
   if(!rows.length&&total!==null&&laneRow.cursor_offset<total)throw Error('eBay returned an incomplete page. Discovery will retry.');
   if(rows.length){
    const known=checked(await db.from('ebay_return_cases').select('ebay_return_id,provider_fingerprint,synced_at,status').eq('source_lane',lane).in('ebay_return_id',rows.map(externalId)))||[];
    const pending=[];
    for(const row of rows){
     const hash=await fingerprint(row),saved=known.find((r:any)=>r.ebay_return_id===externalId(row));
     if(saved?.provider_fingerprint===hash && (['closed','cancelled'].includes(saved.status)||saved.synced_at&&Date.parse(saved.synced_at)>Date.now()-10*60000))continue;
     const terminal=/(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)/i.test(String(row.paymentDisputeStatus||row.caseStatusEnum||row.inquiryStatusEnum||row.status||row.state||''));
     pending.push({lane,external_id:externalId(row),summary:{...row,__fingerprint:hash},state:'queued',priority:terminal&&(!saved||['closed','cancelled'].includes(saved.status))?20:0,attempts:0,next_attempt_at:iso(),updated_at:iso()});
    }
    if(pending.length)checked(await db.from('ebay_issue_sync_jobs').upsert(pending,{onConflict:'lane,external_id',ignoreDuplicates:true}));
   }
   const more=total===null?!!payload.next||rows.length===100:laneRow.cursor_offset+rows.length<total;
   checked(await db.from('ebay_issue_sync_lanes').update({cursor_offset:more?laneRow.cursor_offset+rows.length:0,cycle_started_at:more?cycle:null,
    fetched_entries:laneRow.cursor_offset+rows.length,total_entries:total,last_attempt_at:iso(),...(more?{}:{last_success_at:iso()}),
    next_run_at:iso(more?0:5*60000),status:more?'syncing':'ok',error:null,error_count:0}).eq('lane',lane));
  }catch(error){
   const text=message(error),access=/401|403|scope|access.denied|unauthorized|not.authorized/i.test(text);
   checked(await db.from('ebay_issue_sync_lanes').update({last_attempt_at:iso(),status:access?'needs_access':'error',error:text,error_count:laneRow.error_count+1,
    next_run_at:iso(access?30*60000:Math.min(15*60000,60000*2**Math.min(4,laneRow.error_count)))}).eq('lane',lane));
  }
 }
 // Refresh known unresolved cases even when older than a discovery date window.
 const stale=checked(await db.from('ebay_return_cases').select('source_lane,ebay_return_id').not('ebay_return_id','is',null)
  .not('status','in','(closed,cancelled)').or(`synced_at.is.null,synced_at.lt.${iso(-10*60000)}`).order('last_sync_attempt_at',{nullsFirst:true}).limit(12));
 if(stale?.length)checked(await db.from('ebay_issue_sync_jobs').upsert(stale.map((c:any)=>({lane:c.source_lane,external_id:c.ebay_return_id,summary:{},priority:0})),{onConflict:'lane,external_id',ignoreDuplicates:true}));
 const jobs=checked(await db.from('ebay_issue_sync_jobs').select('*').in('state',['queued','retry']).lte('next_attempt_at',iso()).order('priority').order('next_attempt_at').limit(12))||[];
 let processed=0;
 for(const job of jobs){
  if(Date.now()-started>42000)break;
  const lane=job.lane as Lane;
  checked(await db.from('ebay_return_cases').update({last_sync_attempt_at:iso()}).eq('source_lane',lane).eq('ebay_return_id',job.external_id));
  try{
   const access=await token(lane);
   const detail=await deps.read(access,detailPath(lane,job.external_id),lane==='payment_dispute');
   let files:any={};
   if(lane==='return'){
    // Failure to load attachments is retried, never represented as no evidence.
    files=await deps.read(access,`/post-order/v2/return/${encodeURIComponent(job.external_id)}/files`);
   }
   await deps.process(db,lane,{...job.summary,__ogIssueLane:lane,[lane==='return'?'returnId':lane==='inquiry'?'inquiryId':lane==='case'?'caseId':'paymentDisputeId']:job.external_id},detail,files);
   checked(await db.from('ebay_issue_sync_jobs').delete().eq('lane',lane).eq('external_id',job.external_id).eq('updated_at',job.updated_at));
   processed++;
  }catch(error){
   checked(await db.from('ebay_return_cases').update({sync_error:message(error)}).eq('source_lane',lane).eq('ebay_return_id',job.external_id));
   checked(await db.from('ebay_issue_sync_jobs').update({state:'retry',attempts:job.attempts+1,last_error:message(error),updated_at:iso(),
    next_attempt_at:iso(Math.min(60*60000,60000*2**Math.min(6,job.attempts)))}).eq('lane',lane).eq('external_id',job.external_id).eq('updated_at',job.updated_at));
  }
 }
 return {processed};
}
