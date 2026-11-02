(()=>{
 'use strict';
 const receiver='https://antdamus.github.io/Invsto/ebay-report-refresh.html?job=';
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const shift=(day,n)=>new Date(Date.parse(day+'T12:00Z')+n*86400000).toISOString().slice(0,10);
 const pacificDay=()=>new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'America/Los_Angeles'}).format(new Date());
 function midnight(day){
  const test=Date.parse(day+'T07:00:00Z');
  return new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:'America/Los_Angeles'}).format(test)==='00'?test:test+3600000;
 }
 function pageUrl(job,offset){
  const add=(path,params)=>'https://www.ebay.com'+path+'?'+new URLSearchParams(params).toString();
  if(job.kind==='orders')return add('/sh/ord/',{filter:'status:ALL_ORDERS,timerange:CUSTOM',startDate:midnight(job.from),endDate:midnight(job.to),limit:200,offset});
  if(job.kind==='cases')return add('/sh/ord/cancel',{filter:'status:CANCEL_CLOSED,timerange:LAST6M',limit:200,offset});
  if(job.kind==='payments')return add('/sh/fin/transactions',{q:'orderId:'+job.id,limit:30,offset});
  return add('/Cancel/Details',{cancelId:job.id});
 }
 async function collect(input){
  const job={kind:input.kind,id:input.id};
  if(job.kind==='orders'){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(job.id)||job.id>pacificDay())throw Error('Invalid order window.');
   job.from=job.id;job.to=[shift(job.id,6),pacificDay()].sort()[0];
  }else if(job.kind==='payments'&&!/^\d{2}-\d{5}-\d{5}$/.test(job.id)||job.kind==='case_detail'&&!/^\d+$/.test(job.id)
   ||!['cases','case_detail','payments'].includes(job.kind))throw Error('Invalid report source.');
  let tab,offset=0,total=null;const rows=[],seen=new Set(),startTime=Date.now();
  try{
   do{
    if(Date.now()-startTime>170000)throw Error('Seller Hub did not finish this check in time.');
    const url=pageUrl(job,offset);
    if(tab)await chrome.tabs.update(tab.id,{url});else tab=await chrome.tabs.create({url,active:false});
    let page,last;
    for(let i=0;i<55;i++){
     try{
      const result=await chrome.tabs.sendMessage(tab.id,{type:'OG_PERFORMANCE_PAGE',job});
      if(result?.ok&&(result.page.start===offset+1||!offset&&result.page.total===0)){page=result.page;break;}
      if(result?.message)last=result.message;
     }catch{/* The document may still be loading. */}
     await wait(350);
    }
    if(!page)throw Error(last||'Could not verify the signed-in Seller Hub page.');
    total??=page.total;
    if(total!==page.total||total>25000||page.end>total||(total>0&&page.end<=offset))throw Error('Seller Hub changed during pagination. Retrying later.');
    if(job.kind!=='payments'&&page.rows.length!==page.end-offset)throw Error('Incomplete Seller Hub result range.');
    for(const row of page.rows){
     const key=row.id||[row.order_id,row.reference,row.day,row.gross,row.net].join('/');
     if(seen.has(key))throw Error('A Seller Hub entry appeared twice. Retrying later.');
     seen.add(key);rows.push(row);
    }
    offset=page.end;
   }while(offset<total);
   return {ok:true,rows,count:rows.length};
  }finally{if(tab?.id!=null)await chrome.tabs.remove(tab.id).catch(()=>{});}
 }
 chrome.runtime.onMessage.addListener((m,s,send)=>{
  if(m?.type!=='OG_PERFORMANCE_READ'||s.frameId!==0||!s.tab?.id||!s.url?.startsWith(receiver))return;
  collect(m.job||{}).then(send,e=>send({ok:false,message:e.message}));return true;
 });
})();
