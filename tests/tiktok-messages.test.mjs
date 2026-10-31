import {test} from 'node:test';
import assert from 'node:assert/strict';
import {message,conversation,page,chatClient,CONVERSATIONS_PATH} from '../supabase/functions/tiktok-messages/provider.ts';
import {prepareReply,dispatchReply} from '../supabase/functions/tiktok-messages/sending.ts';
import {sign,TikTokError} from '../supabase/functions/tiktok-order-sync/tiktok.ts';
const msg=(patch={})=>({id:'7494924360615101686',index:'9007199254740993123',create_time:1793455200,type:'TEXT',content:JSON.stringify({content:'Is my order ready?'}),sender:{role:'BUYER',nickname:'Pat'},...patch});
const chat=()=>({id:'7494924360615101685',participants:[{role:'BUYER',user_id:'7494924360615101687',im_user_id:'1111111111111111111',nickname:'Pat'},{role:'SHOP',user_id:'7494924360615101689'}],latest_message:msg(),unread_count:2,can_send_message:true});
test('buyer matches the orders API ID, long IDs stay exact, and hidden content is excluded',()=>{
 const c=conversation(chat());assert.equal(c.buyer_id,'7494924360615101687');assert.equal(c.latest_message.index,'9007199254740993123');assert.equal(c.latest_message.role,'BUYER');assert.equal(c.unread_count,2);
 assert.equal(message(msg({is_visible:false})),null);assert.equal(conversation({...chat(),latest_message:msg({is_visible:false})}).latest_message,null);
 assert.throws(()=>message(msg({id:7494924360615101686})),/identifier/);assert.throws(()=>conversation({...chat(),participants:[]}),/buyer/);
});
test('content is parsed without HTML execution and unsafe media is rejected',()=>{
 assert.equal(message(msg({content:'{"content":"<script>bad</script>"}'})).text,'<script>bad</script>');
 for(const url of ['javascript:alert(1)','http://images.test/a','https://user:pass@images.test/a'])assert.equal(message(msg({type:'IMAGE',content:JSON.stringify({url})})).url,null);
 assert.equal(message(msg({type:'IMAGE',content:'{"url":"https://images.test/a"}'})).url,'https://images.test/a');
 assert.equal(message(msg({content:'invalid'})).text,'');assert.throws(()=>message(msg({create_time:'tomorrow'})),/time/);
});
test('pagination handles terminal empty results and rejects broken cursors/lists',()=>{
 assert.deepEqual(page({},'messages'),{rows:[],next_page_token:null});assert.equal(page({messages:[msg()],next_page_token:'next'},'messages').rows.length,1);
 assert.throws(()=>page({messages:[],next_page_token:'loop'},'messages','loop'),/pagination/);assert.throws(()=>page({next_page_token:'next'},'messages'),/list/);assert.throws(()=>page({messages:{},next_page_token:''},'messages'),/list/);
 assert.throws(()=>page({messages:[],next_page_token:'a'.repeat(4097)},'messages'),/pagination/);
});
test('read endpoints remain GET-only, signed, redirect-safe and redact vendor secrets',async()=>{
 let sent;const client=chatClient('app','secret',async(url,options)=>{sent={url:new URL(url),options};return Response.json({code:0,data:{conversations:[]}});});
 await client.read(CONVERSATIONS_PATH,'test-access',{shop_cipher:'shop',page_size:'20'});assert.equal(sent.options.method,'GET');assert.equal(sent.options.redirect,'error');assert.equal(sent.options.headers['x-tts-access-token'],'test-access');assert.ok(sent.url.searchParams.get('sign'));assert.ok(!sent.url.href.includes('test-access'));
 await assert.rejects(client.read(CONVERSATIONS_PATH+'/1/messages/read','test',{}),/Unsupported/);
 const bad=chatClient('app','secret',async()=>Response.json({code:105005,message:'token=secret-token',request_id:'request'}));await assert.rejects(bad.read(CONVERSATIONS_PATH,'test',{}),e=>!e.message.includes('secret-token'));
});

test('replies use the current sending API, sign exact JSON, and validate receipts without retrying',async()=>{
 let calls=[];const client=chatClient('app','secret',async(url,options)=>{calls.push({url:new URL(url),options});return Response.json({code:0,data:{message_id:'7494924360615101686'}});});
 assert.equal(await client.send('7494924360615101685','test-access','shop','TEXT',{content:'Hello "Pat" 👋'}),'7494924360615101686');
 const sent=calls[0];assert.equal(sent.url.pathname,'/customer_service/202606/conversations/7494924360615101685/messages');assert.equal(sent.options.method,'POST');assert.equal(JSON.parse(sent.options.body).content,JSON.stringify({content:'Hello "Pat" 👋'}));assert.equal(sent.url.searchParams.get('sign'),await sign(sent.url.pathname,Object.fromEntries(sent.url.searchParams),sent.options.body,'secret'));assert.equal(sent.options.redirect,'error');
 await assert.rejects(client.send('bad','token','shop','TEXT',{content:'hi'}),/identifier/);assert.equal(calls.length,1);
 const lost=chatClient('app','secret',async()=>{throw Error('https://example.test?token=private');});await assert.rejects(lost.send('7494924360615101685','token','shop','TEXT',{content:'hi'}),e=>/Check the conversation/.test(e.message)&&!e.message.includes('private'));
 const malformed=chatClient('app','secret',async()=>Response.json({code:0,data:{message_id:7494924360615101686}}));await assert.rejects(malformed.send('7494924360615101685','token','shop','TEXT',{content:'hi'}),/receipt/);
});

const png=()=>new File([Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3])],'test.png',{type:'image/png'});
test('photos enforce file signatures and limits; multipart signs without a JSON body',async()=>{
 await assert.rejects(prepareReply({type:'TEXT',text:'a'.repeat(2001)}),/2,000/);await assert.rejects(prepareReply({type:'TEXT',text:'  '}),/reply/);
 await assert.rejects(prepareReply({type:'IMAGE'},new File(['<svg/>'],'fake.png',{type:'image/png'})),/valid/);await assert.rejects(prepareReply({type:'IMAGE'},new File([new Uint8Array(10*1024*1024+1)],'big.jpg',{type:'image/jpeg'})),/10 MB/);
 let sent;const client=chatClient('app','secret',async(url,options)=>{sent={url:new URL(url),options};return Response.json({code:0,data:{url:'https://images.test/a',width:400,height:300}});});
 assert.deepEqual(await client.upload(png(),'token','shop'),{url:'https://images.test/a',width:400,height:300});assert.equal(sent.options.body.get('data').type,'image/png');assert.equal(sent.options.headers['content-type'],undefined);assert.equal(sent.url.searchParams.get('sign'),await sign(sent.url.pathname,Object.fromEntries(sent.url.searchParams),'','secret'));
});

test('one claim sends at most once; failures preserve an honest receipt and never auto retry',async()=>{
 const body={requestId:'request',type:'TEXT',text:'Your order is ready.'},prepared=await prepareReply(body);let sending=0,claim={dispatch:true,attempt:{id:'request'}};
 const deps={claim:async()=>claim,send:async()=>{sending++;return '7494924360615101686';},finish:async(id,status,provider_message_id,error)=>({id,status,provider_message_id,error})};
 assert.equal((await dispatchReply(deps,body,prepared)).attempt.status,'sent');assert.equal(sending,1);
 claim={dispatch:false,attempt:{id:'request',status:'sent'}};await dispatchReply(deps,body,prepared);assert.equal(sending,1);
 claim={dispatch:true,attempt:{id:'request'}};deps.send=async()=>{sending++;throw Error('Network unavailable');};assert.equal((await dispatchReply(deps,body,prepared)).attempt.status,'unknown');assert.equal(sending,2);
 deps.send=async()=>{sending++;throw new TikTokError('45109001','r');};const rejected=await dispatchReply(deps,body,prepared);assert.equal(rejected.attempt.status,'failed');assert.match(rejected.attempt.error,/Reopen chat/);
 deps.send=async()=>{throw new TikTokError('45101001','r');};assert.equal((await dispatchReply(deps,body,prepared)).attempt.status,'unknown');
 deps.send=async()=> '7494924360615101686';deps.finish=async()=>{throw Error('DB unavailable');};const receipt=await dispatchReply(deps,body,prepared);assert.equal(receipt.attempt.status,'sent');assert.equal(receipt.attempt.provider_message_id,'7494924360615101686');assert.match(receipt.warning,/do not resend/);
});

test('a failed image upload cannot send a buyer message',async()=>{
 const file=png(),body={type:'IMAGE',requestId:'photo'},prepared=await prepareReply(body,file);let sends=0;
 const result=await dispatchReply({claim:async()=>({dispatch:true,attempt:{id:'photo'}}),upload:async()=>{throw Error('Upload unavailable');},send:async()=>{sends++;},finish:async(id,status)=>({id,status})},body,prepared,file);
 assert.equal(result.attempt.status,'failed');assert.equal(sends,0);
});
