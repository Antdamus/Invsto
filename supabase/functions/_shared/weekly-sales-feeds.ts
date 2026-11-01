// Commit the page and its cursor together. An overlapping worker cannot replace
// newer evidence or advance the cursor past a page that failed to save.
export const day=86400000;
export const startOfHistory=(now:number)=>new Date(Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth()-3,1)).toISOString();
export async function loadFeed(db:any,market:string){
 const {data,error}=await db.from('weekly_sales_feed').select('*').eq('market',market).single();
 if(error||!data)throw Error('Sales reconciliation state unavailable');return data;
}
export async function commitFeed(db:any,f:any,state:string,progress=f.progress,through=f.through_at,refunds:any[]=[],settlements:any[]=[]){
 const {error}=await db.rpc('save_weekly_sales_page',{_market:f.market,_expected:f.checked_at,_state:state,_progress:progress,
  _through:through,_refunds:refunds,_settlements:settlements});if(error)throw Error('Sales reconciliation page could not be saved');
}
export async function syncRefundFeed(db:any,market:string,run:(f:any,now:number)=>Promise<void>){
 const f=await loadFeed(db,market),now=Date.now(),gap=f.state==='permission'?3600000:f.state==='ready'?300000:15000;
 if(f.checked_at&&now-Date.parse(f.checked_at)<gap)return;
 try{await run(f,now);}catch{await commitFeed(db,f,'error');}
}
