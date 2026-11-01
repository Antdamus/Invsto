import {commitFeed,day,syncRefundFeed} from '../_shared/weekly-sales-feeds.ts';

function csvRows(text:string){
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(ch==='"'&&quoted&&text[i+1]==='"'){field+='"';i++;}
  else if(ch==='"')quoted=!quoted;
  else if(!quoted&&(ch===','||ch==='\n')){row.push(field.replace(/\r$/,''));field='';if(ch==='\n'){rows.push(row);row=[];}}
  else field+=ch;
 }
 if(quoted)throw Error('Invalid financial CSV');if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
 return rows;
}
export function financialRows(text:string,checked:string){
 const rows=csvRows(text.replace(/^\uFEFF/,'')),head=rows.findIndex(r=>r.includes('ledger_transaction_id')&&r.includes('order_id'));
 if(head<0)throw Error('Missing ledger columns');
 const headers=rows[head],settlements:any[]=[],refunds:any[]=[];
 if(!['transaction_amount','transaction_currency','transaction_type','transaction_message','transaction_completed_at_utc'].every(k=>headers.includes(k)))throw Error('Incomplete ledger schema');
 const seen=new Set<string>();
 for(const row of rows.slice(head+1)){
  if(row.every(v=>!v))continue;
  if(row.length!==headers.length)throw Error('Incomplete ledger row');
  const value=(name:string)=>row[headers.indexOf(name)]?.trim()||'',order=value('order_id'),external=value('ledger_transaction_id');
  if(!order)continue; // Account-wide movements cannot be allocated to a purchase week.
  if(!/^\d{1,20}$/.test(order)||!external||seen.has(external))throw Error('Ambiguous ledger identity');
  seen.add(external);
  const kind=value('transaction_type'),message=value('transaction_message'),amount=value('transaction_amount'),currency=value('transaction_currency');
  if(!/^-?\d+(\.\d+)?$/.test(amount)||!kind||!currency)throw Error('Invalid ledger amount');
  if(/payout|bank.transfer|withdrawal/i.test(kind))continue;
  settlements.push({external_id:external,order_number:order,amount:Number(amount),currency,kind,checked_at:checked});
  // The statement's transaction_amount is a seller ledger entry. A refund
  // entry alone does not identify the pretax merchandise component.
  if(/refund|chargeback|dispute|adjustment/i.test(kind+' '+message)&&Number(amount)<0){
   refunds.push({external_id:external,order_number:order,state:'completed',item_amount:null,currency,source_updated_at:checked});
  }
 }
 return {settlements,refunds};
}
async function reportText(raw:string){
 const url=new URL(raw),host=url.hostname;
 if(url.protocol!=='https:'||url.username||url.password||url.port||
  !/(^|\.)(whatnot\.com|whatnotcdn\.com|s3[.-][a-z0-9.-]+\.amazonaws\.com|s3\.amazonaws\.com|storage\.googleapis\.com)$/.test(host))throw Error('Unknown report host');
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(18000)});
 if(!response.ok||!response.body)throw Error('Report download unavailable');
 const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,text='';
 while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>8*1024*1024){await reader.cancel();throw Error('Financial report too large');}text+=decoder.decode(part.value,{stream:true});}
 return text+decoder.decode();
}
export async function syncWeeklyWhatnot(db:any,api:any){
 await syncRefundFeed(db,'whatnot',async(f,now)=>{
  const p=f.progress||{},today=new Date(now),coverage=p.coverage_start||new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()-1,1)-7*day).toISOString();
  // Whatnot requires UTC timestamps with exactly three fractional digits, even for saved Postgres cursors.
  const from=new Date(p.from||f.through_at||coverage).toISOString();
  const until=new Date(p.until||Math.min(now,Date.parse(from)+7*day)).toISOString();
  if(Date.parse(until)-Date.parse(from)<3600000&&!p.run)return;
  let report;
  try{
   report=p.run?await api.read('/reports/'+p.run):await api.read('/reports',{},{
    report_parameters:{report_type:'seller_financial_report',start_date:from,end_date:until}});
  }catch(e){if(e instanceof Error&&e.message==='Financial report permission required'){await commitFeed(db,f,'permission');return;}throw e;}
  if(!/^[a-f0-9-]{36}$/i.test(report.id)||report.report_type!=='seller_financial_report')throw Error('Invalid report');
  if(report.status==='pending'||report.status==='in_progress'){await commitFeed(db,f,'loading',{coverage_start:coverage,from,until,run:report.id});return;}
  if(report.status!=='completed'||!report.report_url){await commitFeed(db,f,'error',{coverage_start:coverage});return;}
  const checked=new Date(now).toISOString(),facts=financialRows(await reportText(report.report_url),checked);
  await commitFeed(db,f,now-Date.parse(until)<2*3600000?'ready':'loading',{coverage_start:coverage},until,facts.refunds,facts.settlements);
 });
}
