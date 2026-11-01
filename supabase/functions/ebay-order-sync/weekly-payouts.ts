// A payout ID is assigned before money is sent. Read both the payout's final
// status and its individual transactions; never assign a balance withdrawal by date.
type Row=Record<string,any>;
const root='/sell/finances/v1/', day=86400000;
const fmt=(ms:number)=>new Date(ms).toISOString();
const idOK=(v:any)=>typeof v==='string'&&/^[\w-]{1,100}$/.test(v);
const amount=(v:any)=>/^\d+(?:\.\d{1,2})?$/.test(String(v??''))?Number(v):NaN;
const safeError=(e:unknown)=>'Payout check '+(String(e).includes('(429)')?'rate limited':'incomplete')+'; retry scheduled';
async function pages(read:(p:string)=>Promise<any>,resource:string,filter:string,key:string){
 const out:Row[]=[];let expected=-1;
 for(let i=0;i<25;i++){
  const res=await read(root+resource+'?'+new URLSearchParams({filter,limit:'200',offset:String(out.length)}));
  const rows=res?.[key]??(res?.total===0?[]:null);
  if(!Array.isArray(rows)||!Number.isInteger(res.total)||res.total<0||expected!==-1&&expected!==res.total||rows.length>200)throw Error('Incomplete payout response');
  expected=res.total;out.push(...rows);
  if(out.length===expected&&!res.next)return out;
  if(!res.next||out.length>=expected||!rows.length)throw Error('Incomplete payout page');
 }
 throw Error('Incomplete payout range');
}
export function payoutEntries(id:string,transactions:Row[]){
 const entries=new Map<string,Row>();
 for(const t of transactions){
  if(t.payoutId&&t.payoutId!==id)throw Error('Unrelated payout returned');
  if(!/^\d{2}-\d{5}-\d{5}$/.test(t.orderId??'')||['PAYOUT','TRANSFER','WITHDRAWAL'].includes(t.transactionType)||t.transactionStatus==='FAILED')continue;
  if(t.payoutId!==id||!idOK(t.transactionId)||!t.transactionType||!['DEBIT','CREDIT'].includes(t.bookingEntry)||!t.amount?.currency)throw Error('Missing order payout evidence');
  const n=amount(String(t.amount.value).replace(/^-/,''));
  if(!Number.isFinite(n))throw Error('Missing payout transaction amount');
  const e={txn:t.transactionId,kind:t.transactionType,order_number:t.orderId,currency:t.amount.currency,signed_amount:(t.bookingEntry==='DEBIT'?-1:1)*n};
  const k=JSON.stringify([e.txn,e.kind]);
  if(entries.has(k)&&JSON.stringify(entries.get(k))!==JSON.stringify(e))throw Error('Conflicting order payout entries');
  entries.set(k,e);
 }
 return [...entries.values()];
}
export async function syncWeeklyPayouts(db:any,read:(p:string)=>Promise<any>,timeLeft:()=>boolean){
 const now=Date.now(),scan=await db.from('weekly_ebay_payout_scan').select('next_at,last_error').eq('singleton',true).single();
 if(scan.error||!scan.data)return;
 if(scan.data.last_error?.includes('rate limited')&&Date.parse(scan.data.next_at)>now)return;
 if(Date.parse(scan.data.next_at)<=now){
  try{
   const from=now-90*day;
   const ps=await pages(read,'payout','payoutDate:['+fmt(from)+'..'+fmt(now)+']','payouts');
   const rows=ps.map(p=>{
    const value=amount(p.amount?.value);
    if(!idOK(p.payoutId)||!p.payoutStatus||!p.amount?.currency||!Number.isFinite(value)||!Number.isFinite(Date.parse(p.payoutDate)))throw Error('Invalid payout');
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(p.payoutDate));
    return {id:p.payoutId,status:p.payoutStatus,amount:value,currency:p.amount.currency,reported_day:date,source:'Finances API',checked_at:fmt(now)};
   });
   if(new Set(rows.map(p=>p.id)).size!==rows.length)throw Error('Duplicate payout pages');
   if(rows.length&&(await db.from('weekly_ebay_payout_batches').upsert(rows,{onConflict:'id'})).error)throw Error('Payout write failed');
   await db.from('weekly_ebay_payout_scan').update({last_success:fmt(now),last_error:null,next_at:fmt(now+4*3600000)}).eq('singleton',true);
  }catch(e){await db.from('weekly_ebay_payout_scan').update({last_error:safeError(e),next_at:fmt(now+1800000)}).eq('singleton',true);return;}
 }
 const due=await db.from('weekly_ebay_payout_batches').select('id').lte('next_detail',fmt(now)).order('next_detail').order('reported_day',{ascending:false}).limit(4);
 for(const p of due.data||[]){
  if(!timeLeft())break;
  try{
   const entries=payoutEntries(p.id,await pages(read,'transaction','payoutId:{'+p.id+'}','transactions'));
   const write=await db.rpc('save_weekly_ebay_payout_entries',{_id:p.id,_entries:entries});if(write.error)throw Error('Payout entries could not be saved');
  }catch(e){
   await db.from('weekly_ebay_payout_batches').update({detail_error:safeError(e),next_detail:fmt(now+3600000)}).eq('id',p.id);
   if(String(e).includes('(429)')){
    await db.from('weekly_ebay_payout_scan').update({last_error:safeError(e),next_at:fmt(now+1800000)}).eq('singleton',true);break;
   }
  }
 }
}
