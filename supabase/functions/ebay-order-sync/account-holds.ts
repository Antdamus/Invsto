// This API gives the control total, not the separate reserve transactions in Seller Hub.
export function heldBalance(payload:any):number{
 const f=payload?.fundsOnHold;
 if(f?.currency!=='USD'||typeof f.value!=='string'||!/^\d{1,11}(?:\.\d{1,2})?$/.test(f.value))throw Error('Unconfirmed USD balance');
 return Math.round(Number(f.value)*100);
}
export async function checkAccountHolds(db:any,read:(path:string)=>Promise<any>){
 const now=Date.now(),at=new Date(now).toISOString();
 // Claim the hourly check so overlapping finance jobs cannot multiply API calls.
 const {data,error}=await db.from('ebay_account_holds').update({next_api_at:new Date(now+3600000).toISOString()})
  .eq('singleton',true).lte('next_api_at',at).select('singleton');
 if(error||!data?.length)return;
 try{
  const cents=heldBalance(await read('/sell/finances/v1/seller_funds_summary'));
  await db.from('ebay_account_holds').update({api_at:at,api_cents:cents,api_error:null}).eq('singleton',true);
 }catch(e){
  const status=String(e).match(/failed \((\d{3})\)/)?.[1];
  const reason=status==='429'?'eBay rate-limited the balance check.':status==='403'||status==='401'?'eBay did not authorize the balance check.':'eBay did not confirm a new USD balance.';
  await db.from('ebay_account_holds').update({api_error:reason+' The hourly check will retry.'}).eq('singleton',true);
 }
}
