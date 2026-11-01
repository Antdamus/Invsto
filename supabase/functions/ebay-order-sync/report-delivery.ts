// Trading sometimes supplies actual delivery for each purchased line/package.
// Absence, an estimate, shipping completion, and the passage of time prove nothing.
const orderId=/^\d{2}-\d{5}-\d{5}$/;
function blocks(s:string,key:string){
 return [...s.matchAll(new RegExp('<'+key+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+key+'>','g'))].map(m=>m[1]);
}
export function deliveryResults(xml:string,ids:string[],seller:string,now=Date.now()){
 if(!['Success','Warning'].includes(blocks(xml,'Ack')[0])){
  const code=blocks(xml,'ErrorCode')[0];throw Error(/^\d{1,12}$/.test(code||'')?'Trading '+code:'Trading unavailable');
 }
 const results=new Map<string,string|null>();
 for(const order of blocks(xml,'Order')){
  const id=blocks(order,'OrderID')[0];
  if(!ids.includes(id)||results.has(id)||blocks(order,'SellerUserID')[0]?.toLowerCase()!==seller.toLowerCase())continue;
  const lines=blocks(order,'Transaction'),dates:string[]=[];
  const confirmed=lines.length>0&&lines.every(line=>{
   const packages=blocks(line,'ShippingPackageInfo');
   return packages.length>0&&packages.every(p=>{
    const date=blocks(p,'ActualDeliveryTime')[0];
    if(!date||!/^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(date)||!(Date.parse(date)<=now))return false;
    dates.push(new Date(date).toISOString());return true;
   });
  });
  results.set(id,confirmed?dates.sort().at(-1)!:null);
 }
 return results;
}
export async function checkDelivery(db:any,accessToken:string){
 const {data:ids,error}=await db.rpc('claim_ebay_delivery_checks');
 if(error||!ids?.length||!ids.every((id:any)=>orderId.test(id)))return;
 const token=Deno.env.get('EBAY_AUTH_TOKEN'),seller=Deno.env.get('EBAY_SELLER_USER_ID')||'ogjewelers';
 const headers:Record<string,string>={'Content-Type':'text/xml','X-EBAY-API-CALL-NAME':'GetOrders',
 'X-EBAY-API-SITEID':'0','X-EBAY-API-COMPATIBILITY-LEVEL':Deno.env.get('EBAY_COMPATIBILITY_LEVEL')||'1225'};
 const escape=(s:string)=>s.replace(/[<>&'"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]!));
 async function lookup(legacy:boolean){
 const auth={...headers};
 if(legacy){for(const [key,env] of [['DEV-NAME','EBAY_DEV_ID'],['APP-NAME','EBAY_APP_ID'],['CERT-NAME','EBAY_CERT_ID']]){
  const value=Deno.env.get(env);if(value)auth['X-EBAY-API-'+key]=value;}}
 else auth['X-EBAY-API-IAF-TOKEN']=accessToken;
 const body='<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">'+(legacy&&token?'<RequesterCredentials><eBayAuthToken>'+escape(token)+'</eBayAuthToken></RequesterCredentials>':'')+
 '<OrderIDArray>'+ids.map((id:string)=>'<OrderID>'+id+'</OrderID>').join('')+'</OrderIDArray><OrderRole>Seller</OrderRole><DetailLevel>ReturnAll</DetailLevel></GetOrdersRequest>';
 const res=await fetch('https://api.ebay.com/ws/api.dll',{method:'POST',headers:auth,body,signal:AbortSignal.timeout(3500)});
 if(!res.ok)throw Error('HTTP '+res.status);return deliveryResults(await res.text(),ids,seller);
 }
 try{
 const now=new Date().toISOString();let facts;
 try{facts=await lookup(false);}catch(e){if(!token||!/^(Trading |HTTP 40[13])/.test(String((e as Error)?.message)))throw e;facts=await lookup(true);}
 await Promise.all((ids as string[]).map(async id=>{
  const at=facts.get(id);
  if(!facts.has(id)){await db.from('ebay_report_watch').update({api_note:'No matching seller order in the package response.'}).eq('order_number',id).is('delivery',null);return;}
  const r=await db.from('ebay_report_watch').update({api_checked:now,api_note:at?null:'No actual delivery time returned for every purchased line.',...(at?{delivery:{description:'Delivered',at,source:'eBay package delivery record',checked:now}}:{})})
  .eq('order_number',id).is('delivery',null);
  if(r.error)throw Error('Could not save delivery evidence');
 }));
 }catch(e){
  const reason=(e as Error)?.message,code=/^(Trading \d{1,12}|HTTP \d{3})$/.test(reason||'')?' ('+reason+')':'';
  await db.from('ebay_report_watch').update({api_note:'Package lookup unavailable'+code+'; Seller Hub can verify delivery.'}).in('order_number',ids).is('delivery',null);
 }
}
