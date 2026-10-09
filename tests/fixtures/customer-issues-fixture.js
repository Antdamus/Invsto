(async()=>{
 const now=new Date().toISOString(),future=new Date(Date.now()+86400000).toISOString();
 const people=[{user_id:'me',display_name:'Jose',email:'jose@example.test',role:'admin',active:true},{user_id:'staff',display_name:'Sandra',email:'sandra@example.test',role:'employee',active:true}];
 const rows=Array.from({length:36},(_,i)=>({id:`case-${i}`,source_lane:i%3===0?'return':i%3===1?'inquiry':'payment_dispute',issue_kind:i%3===0?'return':i%3===1?'request':'dispute',ebay_return_id:`5400123${i}`,order_id:'order-1',order_number:'01-12345-12345',buyer_username:i===0?'alex.watches':`buyer.${i}`,item_title:i===0?'Cartier Panthère · certificate and bracelet inspection':'Jewelry item from the live sale',return_reason:'Item not as described',status:'open',ebay_status:'OPEN',synced_at:now,ebay_due_at:future,open_tasks:1,next_user:'me',opened_at:now,updated_at:now,raw_payload:{},mine:i%2===0,following:i%2!==0}));
 let tasks=[{id:'task-1',return_case_id:'case-0',order_line_ids:['line-1'],title:'Inspect the returned watch',question:'Compare the watch, serial number and certificate with the original item photos. Record the condition before restocking.',status:'assigned',assigned_to_user_id:'me',assigned_by:'staff',created_by:'staff',metadata:{request_kind:'work'},updated_at:now}];
 const line={id:'line-1',item_title:'Cartier Panthère',item_number:'287000000001',quantity:1,fulfilled_quantity:1,line_status:'fulfilled'};
 window.fixtureCalls=[];window.fixtureWrites=[];
 window.fixtureUpdateCase=changes=>{rows[0]={...rows[0],...changes,updated_at:new Date(Date.now()+1000).toISOString()};};
 function query(table){let filters=[],one=false,lim=999;const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},in(){return q;},order(){return q;},overlaps(){return q;},contains(){return q;},or(){return q;},not(){return q;},range(){return q;},limit(n){lim=n;return q;},single(){one=true;return q;},maybeSingle(){one=true;return q;},then(resolve){
  fixtureCalls.push({table});let data=table==='employees'?people:table==='ebay_return_cases'?rows:table==='ebay_return_tasks'?tasks:table==='ebay_order_lines'?[line]:table==='ebay_return_events'?[{id:'event-1',return_case_id:'case-0',action:'updated',notes:'The customer included the certificate. Inspect the clasp and compare with the original photos.',created_at:now,signed_by_email:'sandra@example.test',evidence_photos:[{bucket:'evidence',path:'watch.svg'}]}]:[];
  if(table==='employees'||table==='ebay_return_cases'||table==='ebay_return_tasks')data=data.filter(r=>filters.every(([k,v])=>r[k]===v));
  return Promise.resolve({data:one?data[0]:data.slice(0,lim),error:null}).then(resolve);
 }};return q;}
 const db={storage:{from:()=>({download:async()=>({data:new Blob(['test evidence bytes'],{type:'image/png'})})})},auth:{getSession:async()=>({data:{session:{user:{id:'me'}}}})},from:query,functions:{invoke:async()=>({data:{message:'Refresh queued. You can keep working.'}})},rpc:async(name,args={})=>{
  fixtureCalls.push({rpc:name,args});if(name==='can_access_post_order_issues')return {data:true};if(name==='list_customer_issues'){
   let found=rows.filter(r=>(args._view==='attention'||r.issue_kind===args._view)&&(!args._search||r.buyer_username.includes(args._search))&&(args._scope==='all'||r[args._scope]));
   return {data:{rows:found.slice(args._offset,args._offset+args._limit),total:found.length,counts:{attention:36,return:12,request:12,dispute:12,history:0}}};
  }
  if(name==='customer_issue_sync_health')return {data:{lanes:['return','inquiry','case','payment_dispute'].map(lane=>({lane,status:'ok',last_success_at:now})),queued:0,retrying:0}};
  if(name==='customer_issue_evidence')return {data:{case:rows[0],lines:[line],bag_photos:[{bucket:'evidence',path:'item.png'}],completion_events:[],packaging_photos:[],certificates:[],case_messages:[{direction:'inbound',message_body:'The clasp needs checking.',sent_at:now}],buyer_messages:[]}};
  fixtureWrites.push({name,args});if(name==='advance_task_workflow')tasks[0].status='completed_by_employee';
  return {data:{ok:true}};
 }};
 const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="240"><rect fill="#d5d2b9" width="300" height="240"/><rect x="127" y="12" width="46" height="216" rx="20" fill="#969994"/><rect x="104" y="70" width="92" height="100" rx="20" fill="#dfdfd1" stroke="#747773" stroke-width="9"/><text x="150" y="126" text-anchor="middle" fill="#454d40" font-size="15">CARTIER</text></svg>');
 window.supabase=db;
 if(!location.search.includes('integration')) await OGCustomerIssues.init({supabase:db,user:{id:'me'},employee:people[0],state:{busy:false},lineSelect:'*',normalizeLine:x=>x,mergeLines:()=>{},loadOrderEvents:async()=>[],
 renderReceipt:()=>`<div class="return-task-video-receipt"><img src="${image}" alt="Original sold item screenshot" style="height:190px;max-width:100%;object-fit:contain"/><p>Original sold item · bag 017</p></div>`,renderComplaint:()=>'<p>Buyer says the clasp needs inspection.</p>',renderMessages:()=>'<p>Buyer: Please check the clasp.</p>',bindReceipt:()=>{},hydrateReceipts:async()=>{},loadMessages:async()=>{},hydrateComplaint:async()=>{},signEvidence:async()=>image,openEvidence:()=>{document.querySelector('#issues-feedback').textContent='Full evidence viewer opened';},openIntake:()=>{document.querySelector('#return-intake-modal').classList.remove('hidden');}});
 window.fixtureReady=true;
})();
