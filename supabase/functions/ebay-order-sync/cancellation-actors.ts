type CancelRecord={cancelId?:unknown; requestorType?:string; cancelCloseReason?:string;cancelRequestDate?:{value?:string}};
export async function requestorPage(month:string,read:(params:URLSearchParams)=>Promise<any>,now:number){
 const start=Date.parse(month+'T00:00:00Z');
 const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
 const rows=new Map<string,{id:string;actor:string;requested_at:string|null;close_reason:string|null}>();
 const ids=new Set<string>();let offset=0,total:number|undefined;
 do{
  const params=new URLSearchParams({creation_date_range_from:new Date(start).toISOString(),creation_date_range_to:new Date(Math.min(+end-1,now)).toISOString(),
   role:'SELLER',limit:'500',offset:String(offset),sort:'+CANCEL_ID'});
  const page=await read(params), list=page.cancellations??[],rawCount=page.paginationOutput?.totalEntries??page.total;
  const count=rawCount==null?NaN:Number(rawCount);
  if(!Array.isArray(list)||!Number.isSafeInteger(count)||count<0||count>10000||total!==undefined&&count!==total||
     list.length>500||offset+list.length>count||!list.length&&offset<count)
   throw Error('Incomplete cancellation register (rows '+list.length+', total '+count+', offset '+offset+', reported '+String(page.paginationOutput?.offset??'unspecified')+', fields '+Object.keys(page).join(',')+')');
  // The production endpoint returns offset 1 for its first page even when offset 0 was requested.
  // Distinct cancellation IDs and the reconciled total guard both zero-based and one-based responses.
  total=count;
  for(const record of list as CancelRecord[]){
   const id=String(record.cancelId??'');if(!/^\d+$/.test(id)||ids.has(id))throw Error('Invalid cancellation ID');ids.add(id);
   if(['BUYER','SELLER','SYSTEM','EBAY'].includes(record.requestorType||''))rows.set(id,{id,actor:record.requestorType!,requested_at:record.cancelRequestDate?.value||null,close_reason:record.cancelCloseReason||null});
  }
  offset+=list.length;
 }while(offset<total!);
 return [...rows.values()];
}
export async function discoverRefundOrders(month:string,read:(path:string)=>Promise<any>,now:number){
 const first=Date.parse(month+'T00:00:00Z'),last=new Date(first);last.setUTCMonth(last.getUTCMonth()+1);
 const range=new Date(first).toISOString()+'..'+new Date(Math.min(now,+last-1)).toISOString();
 const records=new Map<string,string>();let offset=0,total:number|undefined;
 do{
  const query=new URLSearchParams({filter:'transactionType:{REFUND}',limit:'200',offset:String(offset)});
  query.append('filter','transactionDate:['+range+']');
  const page=await read('/sell/finances/v1/transaction?'+query),list=page.transactions??[];
  if(!Number.isSafeInteger(page.total)||total!==undefined&&total!==page.total||page.total>10000||page.total<0||!Array.isArray(list)||offset+list.length>page.total||offset<page.total&&!list.length)throw Error('Incomplete refund discovery');
  total=page.total;
  for(const t of list){
   if(t.transactionType!=='REFUND')throw Error('Unexpected refund discovery results');
   if(t.bookingEntry!=='DEBIT'||['FAILED','FUNDS_PROCESSING'].includes(t.transactionStatus)||!/^\d{2}-\d{5}-\d{5}$/.test(t.orderId))continue;
   const time=Date.parse(t.transactionDate);if(!Number.isFinite(time))throw Error('Missing posting date');
   const posted=new Date(time).toISOString();if((records.get(t.orderId)||'')<posted)records.set(t.orderId,posted);
  }
  offset+=list.length;
 }while(offset<total!);
 return Array.from(records,([id,posted])=>({id,posted}));
}
export async function syncCancellationActors(db:any,ticket:unknown,read:(p:URLSearchParams)=>Promise<any>,finance:(p:string)=>Promise<any>){
 const {data:month,error}=await db.rpc('next_ebay_requestor_month');if(error)throw Error('Cancellation schedule unavailable');
 if(!month)return false;
 let rows:Awaited<ReturnType<typeof requestorPage>>=[],notice=null;
 try{
  const entries=await discoverRefundOrders(month,finance,Date.now());
  const queued=await db.rpc('queue_ebay_refund_order_checks',{_ticket:ticket,_entries:entries});
  if(queued.error)throw Error('Refund verification queue unavailable');
 }catch(e){
  const message=e instanceof Error?e.message:'';
  const status=message.match(/failed \((\d{3})\)/)?.[1];
  notice='Refund discovery incomplete · '+(status?'eBay HTTP '+status:message.startsWith('Incomplete refund')||message.startsWith('Unexpected refund')||message.startsWith('Refund verification')?message:'timed out')+'; retry scheduled';
 }
 try{rows=await requestorPage(month,read,Date.now());}
 catch(e){notice=e instanceof Error?e.message:'eBay cancellation check incomplete';}
 const result=await db.rpc('save_ebay_requestors',{_ticket:ticket,_month:month,_rows:rows,_error:notice});
 if(result.error)throw Error('Could not save the cancellation check');
 return !notice;
}
