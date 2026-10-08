import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../../supabase/functions/ebay-message-sync/index.ts',import.meta.url),'utf8');
function runtime(){
 const context=vm.createContext({console,URL,URLSearchParams,Request,Response,Date,crypto,TextEncoder,TextDecoder,setTimeout,clearTimeout,
  Deno:{env:{get:()=>''}},serve:()=>{},fetch:()=>{throw Error('Unexpected network request');}});
 vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm,''),{mode:'transform'}),context);
 return context;
}
test('incremental checkpoints overlap, preserve paging windows, and do not discard undated summaries',()=>{
 const c=runtime();c.input={runType:'incremental',latestSyncLookbackDays:14};c.checkpoint={lastConversationTimestamp:'2026-10-08T16:00:00Z'};
 assert.equal(vm.runInContext('latestSyncStartTime(input,checkpoint)',c),'2026-10-08T15:55:00.000Z');
 c.checkpoint.windowStart='2026-10-01T00:00:00Z';assert.equal(vm.runInContext('latestSyncStartTime(input,checkpoint)',c),c.checkpoint.windowStart);
 assert.equal(vm.runInContext("filterIncrementalConversations(input,[{conversationId:'undated'}],'2026-10-08T00:00:00Z').length",c),1);
});
test('filtered-empty provider page still continues using raw pagination and resumes offset',async()=>{
 const c=runtime();vm.runInContext(`
 var calls=[],progress=[];
 beginCheckpoint=async()=>({resumeOffset:10,lastConversationTimestamp:null,windowStart:'2026-10-01T00:00:00Z',windowEnd:'2026-10-08T00:00:00Z'});
 ebayGet=async(_token,path)=>{calls.push(path);return {conversations:Array.from({length:10},(_,i)=>({conversationId:String(i)})),total:40};};
 filterIncrementalConversations=()=>[];
 processConversationPage=async()=>({rowIds:[],latestTimestamp:null});
 classifyProcessedConversations=async()=>{};updateRunProgress=async()=>{};
 updateCheckpointProgress=async options=>progress.push(options);shouldRunRecentDetailSweep=()=>false;
 `,c);
 c.options={input:{runType:'incremental',conversationPageLimit:10,maxConversationPages:1,startOffset:0,rateLimitPauseMs:0},conversationType:'FROM_MEMBERS',counters:{messagesSeen:0,pagesFetched:0,pagesSucceeded:0,totalsByConversationType:{}}};
 const result=await vm.runInContext('syncConversationType(options)',c);
 assert.equal(result.nextOffset,20);assert.equal(result.exhausted,false);assert.equal(result.paused,true);
 assert.match(c.calls[0],/offset=10/);assert.equal(c.progress[0].input.endTime,'2026-10-08T00:00:00Z');
});
test('targeted detail reuses prefetched first page and fetches subsequent pages',async()=>{
 const c=runtime();vm.runInContext(`var calls=[],saved=[];
 ebayGet=async(_token,path)=>{calls.push(path);return {messages:[{messageId:'last'}],total:3};};
 upsertMessages=async options=>{saved.push(...options.messages);return [];};
 updateConversationFromDetail=async()=>{};upsertConversationLinks=async()=>{};`,c);
 c.options={input:{conversationId:'chat',messagePageLimit:2,maxDetailPagesPerConversation:3,rateLimitPauseMs:0},conversationType:'FROM_MEMBERS',conversationPayload:{conversationId:'chat',messages:[{messageId:'a'},{messageId:'b'}],total:3},conversationRow:{id:'one'},counters:{detailPagesFetched:1,messagesSeen:0}};
 await vm.runInContext('syncConversationDetail(options)',c);
 assert.equal(c.calls.length,1);assert.match(c.calls[0],/offset=2/);assert.equal(c.saved.length,3);
 assert.equal(c.options.counters.detailPagesFetched,2);
});
test('incremental watermark advances only after complete window, not at a page cap',async()=>{
 const c=runtime();const updates=[];c.supa={from:()=>({update:row=>{updates.push(row);return {eq(){return this;},then:resolve=>resolve({error:null})};}})};
 c.options={supabase:c.supa,input:{runType:'incremental',startTime:'2026-10-01T00:00:00Z',endTime:'2026-10-08T00:00:00Z'},account:{id:'one'},exhausted:false,currentRunComplete:true,counters:{},lastConversationTimestamp:'2026-10-07T00:00:00Z'};
 await vm.runInContext('updateCheckpointProgress(options)',c);assert.equal(updates[0].last_conversation_timestamp,undefined);
 c.options.exhausted=true;await vm.runInContext('updateCheckpointProgress(options)',c);assert.equal(updates[1].last_conversation_timestamp,'2026-10-08T00:00:00Z');
});
test('message sync does not run an order sync by default',async()=>{
 const c=runtime();c.request=new Request('https://test.invalid',{method:'POST',body:JSON.stringify({conversationId:'one'})});
 const input=await vm.runInContext('parseInput(request)',c);assert.equal(input.syncRecentOrdersBeforeMessages,false);
});
