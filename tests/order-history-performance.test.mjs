import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../ebay-order-history.js',import.meta.url),'utf8');
function app() {
  const context=vm.createContext({console,URLSearchParams,setTimeout:()=>0,clearTimeout,
    window:{addEventListener(){},location:{search:''}},document:{addEventListener(){}}});
  vm.runInContext(source,context);
  const run=code=>vm.runInContext(code,context);
  run(`var hidden=true, renders=0, signed=0, writes=0, releaseSign;
    var modal={classList:{contains:()=>hidden,remove:()=>{hidden=false},add:()=>{hidden=true}}};
    var list={set innerHTML(v){renders++;},querySelectorAll:()=>[]};
    var container={set innerHTML(v){writes++;},querySelectorAll:()=>[]};
    document.getElementById=id=>id==='proof-trail-modal'?modal:id==='event-list'?list:null;
    document.body={classList:{add(){},remove(){}}};
    document.querySelector=()=>container;
    getFilteredEvents=()=>[];
    getEventEvidencePhotos=event=>event.photos;
    signEventEvidencePhoto=async()=>{signed++;return 'https://example.test/photo.jpg'};`);
  return {run};
}

test('closed Proof Trail does no rendering or evidence signing; opening renders current filters',async()=>{
  const {run}=app();
  run('renderEventList()');
  await run('hydrateEventEvidencePhotos([{photos:[{bucket:"proof",path:"one.jpg"}]}])');
  assert.equal(run('renders'),0); assert.equal(run('signed'),0);
  run('openProofTrailModal()'); assert.equal(run('renders'),1);
  run('closeProofTrailModal(); renderEventList()'); assert.equal(run('renders'),1);
  run('openProofTrailModal()'); assert.equal(run('renders'),2);
});

test('open Proof Trail signs and displays evidence',async()=>{
  const {run}=app(); run('openProofTrailModal()');
  await run('hydrateEventEvidencePhotos([{photos:[{bucket:"proof",path:"one.jpg"}]}])');
  assert.equal(run('signed'),2); assert.equal(run('writes'),1);
});

for (const action of ['closeProofTrailModal()','renderEventList()']) {
  test(`stale photo hydration stops after ${action}`,async()=>{
    const {run}=app(); run(`openProofTrailModal();
      signEventEvidencePhoto=()=>{signed++;return signed===1?new Promise(r=>releaseSign=r):Promise.resolve('https://example.test/photo.jpg')};`);
    const pending=run('hydrateEventEvidencePhotos([{photos:[{bucket:"proof",path:"one.jpg"}]},{photos:[{bucket:"proof",path:"two.jpg"}]}])');
    run(`${action}; releaseSign('https://example.test/photo.jpg')`);
    await pending;
    assert.equal(run('writes'),0); assert.equal(run('signed'),2,'do not start the next event');
  });
}

test('line and order task lookups overlap, then preserve deduplication and event context',async()=>{
  const {run}=app();
  run(`var started=[],releaseLines,releaseOrders,eventReads=0;
    fetchOverlappingRows=()=>{started.push('lines');return new Promise(r=>releaseLines=r)};
    var supabase={from:table=>{
      var query={select:()=>query,in:()=>query,order:()=>query,limit:()=>{
        if(table==='ebay_order_tasks'){started.push('orders');return new Promise(r=>releaseOrders=r)}
        eventReads++;return Promise.resolve({data:[{id:'event',task_id:'order-task',signed_by_email:'worker@example.test'}]});
      }};return query;
    }};`);
  const pending=run(`loadOrderTaskDataForLines(['line'],['order'],{lines:[{id:'line',order_id:'order'}]})`);
  assert.equal(run('started.join(",")'),'lines,orders');
  assert.equal(run('eventReads'),0);
  run(`releaseOrders({data:[{id:'shared',order_id:'order',order_line_ids:['line']},{id:'order-task',order_id:'order',order_line_ids:[],title:'Check proof'}]})`);
  await new Promise(r=>setImmediate(r));
  assert.equal(run('eventReads'),0,'events must wait for both task scopes');
  run(`releaseLines({data:[{id:'shared',order_id:'order',order_line_ids:['line']}],error:null})`);
  const result=JSON.parse(JSON.stringify(await pending));
  assert.equal(result.tasks.length,2);
  assert.deepEqual(result.tasks[1].order_line_ids,['line']);
  assert.equal(result.events[0].task_title,'Check proof');
  assert.equal(result.events[0].created_by_email,'worker@example.test');
  assert.deepEqual(result.events[0].order_line_ids,['line']);
});

test('a failed task lookup rejects instead of publishing incomplete task evidence',async()=>{
  const {run}=app();
  run(`fetchOverlappingRows=async()=>({data:[],error:new Error('Task lookup failed')});`);
  await assert.rejects(run(`loadOrderTaskDataForLines(['line'],[])`),/Task lookup failed/);
});

test('Proof Trail only loads photos near the viewport and bounds simultaneous events',async()=>{
  const {run}=app();
  run(`var photoObserver, observed=[], unloaded=[], photoStarts=[], finishPhoto=[];
    var IntersectionObserver=class {
      constructor(callback){this.callback=callback;photoObserver=this;}
      observe(target){observed.push(target);}
      unobserve(target){unloaded.push(target);}
      disconnect(){}
    };
    var photoTargets=Array.from({length:100},(_,index)=>({dataset:{eventEvidenceIndex:String(index)}}));
    list.querySelectorAll=()=>photoTargets;
    hydrateEventEvidencePhotos=(events,version,indexes)=>{
      photoStarts.push(indexes[0]);return new Promise(resolve=>finishPhoto.push(resolve));
    };
    openProofTrailModal();
    observeEventEvidencePhotos(Array.from({length:100},()=>({})),proofTrailRenderVersion);`);
  assert.equal(run('observed.length'),100);
  assert.equal(run('photoStarts.length'),0,'offscreen photos must not trigger requests');
  run(`photoObserver.callback(photoTargets.slice(0,3).map(target=>({target,isIntersecting:true})),photoObserver)`);
  assert.equal(run('photoStarts.join(",")'),'0,1');
  run('finishPhoto[0]()'); await new Promise(r=>setImmediate(r));
  assert.equal(run('photoStarts.join(",")'),'0,1,2');
  run(`photoObserver.callback([{target:photoTargets[3],isIntersecting:true}],photoObserver);closeProofTrailModal();finishPhoto[1]();finishPhoto[2]();`);
  await new Promise(r=>setImmediate(r));
  assert.equal(run('photoStarts.join(",")'),'0,1,2','closing cancels queued offscreen work');
});
