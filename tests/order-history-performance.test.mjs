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
