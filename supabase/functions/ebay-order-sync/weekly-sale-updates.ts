// Read all fulfillment states by modification date. Store only the financial
// fields the weekly report needs, never fulfillment state or buyer details.
type ApiOrder = Record<string, any>;
const day=86400000;
export function adjustmentPage(from:number,until:number,now:number,offset=0){
 const filter='lastmodifieddate:['+new Date(from).toISOString()+'..'+new Date(until-1).toISOString()+']';
 if(!Number.isFinite(from)||!Number.isFinite(until)||until<=from||until>now)throw Error('Invalid adjustment window');
 return '/sell/fulfillment/v1/order?'+new URLSearchParams({filter,limit:'200',offset:String(offset)});
}
export function adjustmentFields(order:ApiOrder){
 if(!/^\d{2}-\d{5}-\d{5}$/.test(order.orderId)||!Number.isFinite(Date.parse(order.lastModifiedDate)))throw Error('Invalid changed order');
 const refunds=order.paymentSummary?.refunds;
 if(refunds!==undefined&&!Array.isArray(refunds))throw Error('Invalid order refunds');
 const amount=(m:any)=>typeof m?.value==='string'&&m.currency?{value:m.value,currency:m.currency}:undefined;
 const changes={
  orderPaymentStatus:order.orderPaymentStatus||undefined,orderCancelStatus:order.cancelStatus?.cancelState||undefined,
  refunds:refunds?.map((r:ApiOrder)=>({refundReferenceId:r.refundReferenceId,refundId:r.refundId,
   refundStatus:r.refundStatus,refundDate:r.refundDate,amount:amount(r.amount)})),total:amount(order.pricingSummary?.total)
 };
 return {order_number:order.orderId,modified_at:order.lastModifiedDate,changes};
}
export async function syncWeeklySaleUpdates(db:any,ticket:string,read:(path:string)=>Promise<any>){
 const {data:state,error}=await db.from('weekly_ebay_change_cursor').select('through_at,window_end,page_offset,next_at').eq('singleton',true).single();
 if(error||!state)throw Error('Adjustment cursor unavailable');
 const now=Date.now(),from=Date.parse(state.through_at),latest=now-60000;
 if(Date.parse(state.next_at)>now||from>=latest)return;
 let until=state.window_end?Date.parse(state.window_end):Math.min(from+7*day,latest);
 try{
  // Subdivide crowded windows instead of advancing a numeric page offset
  // across a result set that can change while a return is being processed.
  for(let i=0;i<4;i++){
   const offset=state.page_offset||0;
   const data=await read(adjustmentPage(from,until,now,offset)),orders=data?.orders??[];
   if(!Array.isArray(orders)||!Number.isInteger(data.total)||data.total<0)throw Error('Incomplete adjustment response');
   if((data.total>200||data.next)&&!offset&&until-from>=2000){until=from+Math.floor((until-from)/2);continue;}
   const more=offset+orders.length<data.total;
   if(orders.length>200||more&&orders.length!==200||Boolean(data.next)!==more)throw Error('Incomplete adjustment page');
   const page=orders.map(adjustmentFields);
   if(page.some((r:ReturnType<typeof adjustmentFields>)=>Date.parse(r.modified_at)<from||Date.parse(r.modified_at)>=until))throw Error('Order outside adjustment window');
   const write=await db.rpc('save_weekly_ebay_change_page',{_ticket:ticket,_from:state.through_at,_until:new Date(until).toISOString(),_orders:page,_advance:!more,_error:false,_next_offset:more?offset+orders.length:0});
   if(write.error)throw Error('Could not save adjustment page');return more||until<latest-3*60000;
  }
  const narrow=await db.rpc('save_weekly_ebay_change_page',{_ticket:ticket,_from:state.through_at,_until:new Date(until).toISOString(),_orders:[],_advance:false,_error:false});
  if(narrow.error)throw Error('Could not save adjustment window');return true;
 }catch{
  const retry=await db.rpc('save_weekly_ebay_change_page',{_ticket:ticket,_from:state.through_at,_until:new Date(until).toISOString(),_orders:[],_advance:false,_error:true});
  if(retry.error)throw Error('Could not record adjustment retry');
 }
}
