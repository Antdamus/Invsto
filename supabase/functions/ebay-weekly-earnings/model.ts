export const earningsScope='https://api.ebay.com/oauth/api_scope/sell.finances.earnings.read';
export const day=86400000;
export function earningsWindow(cursor:any,now:number){
 const stop=Date.parse(cursor.stop_at||'')||new Date(now-93*day).getTime();
 const end=Date.parse(cursor.window_end||'')||now;
 return {start:Math.max(stop,end-7*day),end,stop,offset:cursor.page_offset||0};
}
export function earningRow(order:any,at:string){
 const s=order?.orderEarningsSummary;
 function amount(v:any){return v?.currency==='USD'&&typeof v.value==='string'&&/^-?\d{1,12}(?:\.\d{1,2})?$/.test(v.value)?Number(v.value):null;}
 const earnings=amount(s?.orderEarnings);
 if(!/^\d{2}-\d{5}-\d{5}$/.test(order?.orderId)||!Number.isFinite(Date.parse(order.orderCreationDate)))throw Error('Invalid earnings order identity');
 if(earnings===null)return null;
 return {order_number:order.orderId,purchased_at:order.orderCreationDate,earnings,gross:amount(s.grossAmount),expenses:amount(s.expenses),refunds:amount(s.refunds),labels:amount(s.expenses?.shippingLabels),checked_at:at};
}
