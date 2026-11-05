import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const saved={id:'draft-id',share_token:'share-id',source_date:'2026-11-05',recipient:'Manny',revision:1,published:null,draft:{recipient:'Manny',source_date:'2026-11-05',prepared_at:'2026-11-05T14:00:00Z',items:[{id:'one',name:'Silver <Pendant>',category:'Pendants',retail_price:420,reference:'OG1',photos:['one.jpg']}]}};
async function harness({publicView=false,incomplete=false}={}){
 const elements=new Map(),handlers=new Map(),calls=[],storage=new Map(),history=[],scripts=[];
 const el=id=>{if(!elements.has(id))elements.set(id,{id,hidden:false,disabled:false,value:'',textContent:'',innerHTML:'',addEventListener:(type,fn)=>handlers.set(id+':'+type,fn)});return elements.get(id);};
 const row=structuredClone(saved);if(incomplete)row.draft.items[0].retail_price=null;
 const client={auth:{getSession:async()=>({data:{session:{user:{id:'staff'}}}})},from:()=>({select:()=>({eq:()=>({order:()=>({limit:async()=>({data:[row]})})})})}),storage:{from:()=>({createSignedUrls:async paths=>({data:paths.map(path=>({path,signedUrl:'https://photos.example/'+path}))})})},rpc:async(name,args)=>{calls.push({name,args});return{data:structuredClone(row)}}};
 const document={readyState:'complete',getElementById:el,querySelectorAll:()=>[],addEventListener:()=>{},createElement:()=>({}),head:{append:s=>{scripts.push(s.src);queueMicrotask(()=>s.onload());}}};
 const context={document,Intl,URL,URLSearchParams,Date,Map,Set,Number,Promise,setTimeout,clearTimeout,queueMicrotask,setInterval:()=>{},navigator:{},location:{search:publicView?'?share=abc':'',href:'https://app.example/inventory-daily-catalogue.html'},history:{replaceState:(_s,_t,url)=>history.push(url)},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},supabase:client,CatalogueViewer:{},fetch:async()=>({ok:true,json:async()=>({...row.draft,items:row.draft.items.map(i=>({...i,images:['https://photos.example/one.jpg']}))})})};context.window=context;
 vm.runInNewContext(await read('catalogue-core.js'),context);vm.runInNewContext(await read('inventory-daily-catalogue.js'),context);await tick();await tick();
 return{elements,el,handlers,calls,storage,history,scripts};
}
test('saved Eastern date remains selected next morning and Gather refreshes the complete dated set',async()=>{
 const h=await harness();assert.equal(h.el('source-date').value,'2026-11-05');assert.equal(h.el('style-count').textContent,1);assert.match(h.el('recipient').textContent,/Manny · eBay/);
 await h.handlers.get('gather:click')();assert.equal(h.calls[0].name,'prepare_inventory_daily_catalogue');assert.equal(h.calls[0].args._date,'2026-11-05');assert.equal(h.storage.get('invsto:manny-catalogue-date'),'2026-11-05');assert.deepEqual(h.history,['?date=2026-11-05']);
 h.el('source-date').value='2026-11-04';h.handlers.get('source-date:change')();assert.equal(h.el('report').hidden,true);assert.equal(h.el('draft-actions').hidden,true);
});
test('incomplete items remain visible and cannot be published; titles escaped in index and cards',async()=>{
 const h=await harness({incomplete:true});assert.equal(h.el('publish').disabled,true);assert.equal(h.el('readiness').hidden,false);assert.match(h.el('item-index').innerHTML,/Silver &lt;Pendant&gt;/);assert.match(h.el('collection').innerHTML,/Price pending/);
});
test('shared review has retail prices, safe anchors, no staff panel or authentication script',async()=>{
 const h=await harness({publicView:true});assert.equal(h.el('recipient').textContent,'Prepared for Manny · eBay');assert.match(h.el('collection').innerHTML,/\$420\.00/);assert.match(h.el('collection').innerHTML,/href="#index"/);assert.equal(h.scripts.length,0);assert.equal(h.calls.length,0);
 const html=await read('inventory-daily-catalogue.html');assert.match(html,/<section id="staff-panel"[^>]*hidden/);assert.match(html,/name="referrer" content="no-referrer"/);
});
