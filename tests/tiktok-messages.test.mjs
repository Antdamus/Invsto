import {test} from 'node:test';
import assert from 'node:assert/strict';
import {message,conversation,page,chatClient,CONVERSATIONS_PATH} from '../supabase/functions/tiktok-messages/provider.ts';
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
test('provider is GET-only, signs requests, prevents redirects and redacts vendor secrets',async()=>{
 let sent;const client=chatClient('app','secret',async(url,options)=>{sent={url:new URL(url),options};return Response.json({code:0,data:{conversations:[]}});});
 await client.read(CONVERSATIONS_PATH,'test-access',{shop_cipher:'shop',page_size:'20'});assert.equal(sent.options.method,'GET');assert.equal(sent.options.redirect,'error');assert.equal(sent.options.headers['x-tts-access-token'],'test-access');assert.ok(sent.url.searchParams.get('sign'));assert.ok(!sent.url.href.includes('test-access'));
 await assert.rejects(client.read(CONVERSATIONS_PATH+'/1/messages/read','test',{}),/Unsupported/);
 const bad=chatClient('app','secret',async()=>Response.json({code:105005,message:'token=secret-token',request_id:'request'}));await assert.rejects(bad.read(CONVERSATIONS_PATH,'test',{}),e=>!e.message.includes('secret-token'));
});
