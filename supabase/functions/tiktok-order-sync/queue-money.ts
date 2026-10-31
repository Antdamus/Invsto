// Optional enrichment for the packing queue. A Finance outage must never block order import.
export const UNSETTLED_PATH='/finance/202507/orders/unsettled';
export const DETAIL_PATH='/order/202507/orders';
export const statementPath=(id:string)=>'/finance/202501/orders/'+id+'/statement_transactions';
const cents=(v:unknown,signed=false)=>typeof v==='string'&&(signed?/^-?\d{1,10}(\.\d{1,2})?$/:/^\d{1,10}(\.\d{1,2})?$/).test(v)?Math.round(Number(v)*100):null;
export function checkoutFacts(payment:any){
 if(payment?.currency!=='USD')return {};
 const shipping=cents(payment.shipping_fee),total=cents(payment.total_amount),tax=cents(payment.tax),discount=cents(payment.platform_discount);
 return {buyer_shipping:shipping===null?null:shipping/100,referral_basis:[total,tax,discount].includes(null)?null:(total!+discount!-tax!)/100};
}
export function statementCharge(data:any,id:string,lines:any[]){
 if(data?.order_id!==id||data.currency!=='USD'||!Array.isArray(data.sku_transactions)||!data.sku_transactions.length||data.total_count!==data.sku_transactions.length)return null;
 const units=new Map<string,number>();
 for(const row of data.sku_transactions){if(!row.statement_id||!Number.isSafeInteger(row.quantity)||row.quantity<1)return null;units.set(row.sku_id,(units.get(row.sku_id)||0)+row.quantity);}
 if(!lines.length||lines.some(l=>units.get(l.sku_id)!==l.quantity)||units.size!==lines.length)return null;
 const amount=cents(data.fee_and_tax_amount,true);return amount===null?null:-amount/100;
}
// Only use a complete response window and a single standard transaction for
// an order. Adjustment entries and paginated results cannot establish the fee.
export function unsettledFees(data:any){
 const result=new Map<string,number|null>();
 if(!Array.isArray(data?.transactions)||data.next_page_token||data.total_count!==data.transactions.length)return result;
 for(const row of data.transactions){
  if(row.status!=='UNSETTLED'||row.type!=='ORDER'||row.currency!=='USD'||!row.order_id)continue;
  const fee=cents(row.est_fee_tax_amount,true);
  result.set(row.order_id,result.has(row.order_id)||fee===null?null:-fee/100);
 }
 return result;
}
export async function refreshQueueMoney(db:any,c:any,api:any,tokens:any){
 const allowed=Array.isArray(tokens.granted_scopes)&&tokens.granted_scopes.includes('seller.finance.info');
 const cutoff=new Date(Date.now()-86400000).toISOString();
 const {data:rows,error}=await db.from('tiktok_orders').select('id,order_number,api_update_time,tiktok_order_lines(sku_id,quantity)').not('stage','in','(completed,dispatched)').not('marketplace_status','in','(Canceled,Cancelled,Completed)').or('finance_checked_at.is.null,finance_checked_at.lt.'+cutoff).order('finance_checked_at',{nullsFirst:true}).order('id').limit(12);
 if(error)throw Error('Queue financial lookup unavailable');
 if(!rows?.length)return;
 const ids=rows.map((r:any)=>r.order_number);
 if(!ids.every((id:string)=>/^\d{10,24}$/.test(id)))throw Error('Invalid order identifier');
 const details=await api.read(DETAIL_PATH,tokens.access_token,{shop_cipher:c.shop_cipher,ids:ids.join(',')});
 let estimates=new Map<string,number|null>();
 const times=(details.orders||[]).map((o:any)=>o.create_time).filter(Number.isSafeInteger);
 if(allowed&&times.length){
  try{estimates=unsettledFees(await api.read(UNSETTLED_PATH,tokens.access_token,{shop_cipher:c.shop_cipher,page_size:'100',sort_field:'order_create_time',search_time_ge:String(Math.min(...times)),search_time_lt:String(Math.max(...times)+1)}));}catch{/* Fall back to the rate estimate. */}
 }
 for(const r of rows){
  const order=details.orders?.find((o:any)=>o.id===r.order_number);
  const facts:any={finance_checked_at:new Date().toISOString(),finance_scope:allowed,...checkoutFacts(order?.payment)};
  if(allowed){
   const estimate=estimates.get(r.order_number);if(estimate!=null)facts.unsettled_fee=estimate;
   try{const data=await api.read(statementPath(r.order_number),tokens.access_token,{shop_cipher:c.shop_cipher});
    const actual=statementCharge(data,r.order_number,r.tiktok_order_lines);if(actual!==null)facts.statement_deductions=actual;
   }catch{/* An open order often has no statement yet. Keep any verified amount. */}
  }
  let update=db.from('tiktok_orders').update(facts).eq('id',r.id);
  update=r.api_update_time?update.eq('api_update_time',r.api_update_time):update.is('api_update_time',null);
  if((await update).error)throw Error('Could not save queue financial data');
 }
}
