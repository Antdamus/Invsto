import {commitFeed,day,startOfHistory,syncRefundFeed} from '../_shared/weekly-sales-feeds.ts';
import {statementPath,statementCharge} from './queue-money.ts';
const id=(v:any)=>typeof v==='string'&&/^\d{10,24}$/.test(v);
export function returnFacts(r:any){
 if(!id(r.order_id)||!id(r.return_id)||!Number.isSafeInteger(r.update_time)||!r.return_status)throw Error('Invalid return');
 const status=r.return_status,ref=r.refund_amount;
 const completed=status==='REPLACEMENT_REQUEST_REFUND_SUCCESS'||status==='RETURN_OR_REFUND_REQUEST_COMPLETE'&&['REFUND','RETURN_AND_REFUND'].includes(r.return_type);
 return {external_id:r.return_id,order_number:r.order_id,state:completed?'completed':/REJECT|CANCEL|COMPLETE/.test(status)?'inactive':'pending',
  item_amount:completed&&/^\d+(\.\d{1,2})?$/.test(ref?.refund_subtotal??'')?Number(ref.refund_subtotal):null,
  currency:ref?.currency||null,source_updated_at:new Date(r.update_time*1000).toISOString()};
}
export async function syncWeeklyTikTok(db:any,c:any,api:any,tokens:any){
 const scopes=tokens.granted_scopes||[];
 await syncRefundFeed(db,'tiktok',async(f,now)=>{
  if(!scopes.includes('seller.return_refund.basic'))return await commitFeed(db,f,'permission');
  const progress=f.progress||{},coverage=progress.coverage_start||startOfHistory(now);
  const from=progress.from??Math.max(Date.parse(coverage),Date.parse(f.through_at||coverage)-60000);
  const until=progress.until??Math.min(now,from+27*day);
  let version=progress.version==='202309'?'202309':'202602';
  const read=()=>api.read(`/return_refund/${version}/returns/search`,tokens.access_token,{shop_cipher:c.shop_cipher,page_size:'50',
   sort_field:'update_time',sort_order:'ASC',...(progress.page?{page_token:progress.page}:{})},
   {update_time_ge:Math.floor(from/1000),update_time_lt:Math.floor(until/1000)});
  let data;
  try{data=await read();}catch(e){
   if(version!=='202602'||progress.page||!['105005','36009009'].includes((e as {code:string}).code))throw e;
   version='202309';data=await read();
  }
  if(!data||(!Array.isArray(data.return_orders)&&data.total_count!==0)||data.next_page_token&&data.next_page_token===progress.page)throw Error('Incomplete return page');
  const refunds=(data.return_orders||[]).map(returnFacts),next=data.next_page_token;
  await commitFeed(db,f,next||until<now-120000?'loading':'ready',next?{version,coverage_start:coverage,from,until,page:next}:{version,coverage_start:coverage},
   next?f.through_at:new Date(until).toISOString(),refunds);
 });
 if(!scopes.includes('seller.finance.info'))return;
 // Revisit completed sales as well as the packing queue. The timestamp rotates
 // the whole shop fairly even when open orders have not settled.
 const {data:orders,error}=await db.from('tiktok_orders').select('id,order_number,tiktok_order_lines(sku_id,quantity)').not('paid_time','is',null)
  .or('weekly_statement_checked_at.is.null,weekly_statement_checked_at.lt.'+new Date(Date.now()-day).toISOString())
  .order('weekly_statement_checked_at',{nullsFirst:true}).order('id').limit(4);
 if(error)throw error;
 for(const o of orders||[]){
  let settlement=null;
  try{const data=await api.read(statementPath(o.order_number),tokens.access_token,{shop_cipher:c.shop_cipher});
   if(statementCharge(data,o.order_number,o.tiktok_order_lines)!==null&&/^-?\d+(\.\d{1,2})?$/.test(data.settlement_amount??'')&&
    /^-?\d+(\.\d{1,2})?$/.test(data.shipping_cost_amount??''))settlement=Number(data.settlement_amount);
  }catch{/* An order may not have a posted statement yet. */}
  const {error}=await db.rpc('save_weekly_tiktok_statement',{_number:o.order_number,_amount:settlement});if(error)throw error;
 }
}
