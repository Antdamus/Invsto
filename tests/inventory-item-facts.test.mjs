import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
const context=vm.createContext({});
vm.runInContext(readFileSync(new URL('../inventory-item-facts.js',import.meta.url),'utf8'),context);
const facts=context.InventoryItemFacts;
const plain=value=>JSON.parse(JSON.stringify(value));

test('watch identity preserves full model variants while removing labeled serial numbers',()=>{
  for(const serial of ['Serial: 123ABC','Serial number 123ABC','S/N: 123ABC','Número de serie 123ABC']){
    assert.equal(facts.watchTitle({brand:'Rolex',name:`Datejust ${serial}`,model:'126233-0035'}),'Rolex Datejust 126233-0035');
  }
  assert.equal(facts.watchTitle({brand:'Rolex',name:'Rolex Datejust',model:'126233-0035'},'', 'Rolex Datejust 126233-0035'),'Rolex Datejust 126233-0035');
  assert.equal(facts.watchTitle({name:'Cartier',model:'WSSA0007 / Serial: 123ABC'}),'Cartier WSSA0007');
});
test('manually edited titles cannot reintroduce an explicitly identified serial or lose aftermarket',()=>{
  const watch={brand:'Cartier',name:'Santos',model:'WSSA0007',modifications:'Aftermarket bezel; Serial 123ABC'};
  const title=facts.watchTitle(watch,'Earth-mined diamonds','Cartier Santos 123ABC');
  assert.equal(title,'Cartier Santos WSSA0007 — Aftermarket, Earth-mined diamonds');
  assert.equal(facts.watchTitle(watch,'Earth-mined diamonds',title),title);
});
test('aftermarket is explicit, but negated aftermarket does not mislabel an unmodified watch',()=>{
  for(const modifications of ['Aftermarket bezel','after-market diamonds','After market dial','No aftermarket dial; aftermarket bezel']) assert.equal(facts.hasAftermarket({modifications}),true);
  for(const modifications of ['No aftermarket parts','Without aftermarket additions','Sin aftermarket','Unknown','']) assert.equal(facts.hasAftermarket({modifications}),false);
});
test('stone categories require explicit origin and distinguish simulants, mixed stones and no stones',()=>{
  for(const stone of ['Earth-mined diamonds','Earth natural diamonds','Natural diamond']) assert.deepEqual(plain(facts.stoneCategories(stone)),['Earth-mined diamonds']);
  for(const stone of ['Lab diamond','Lab-grown diamonds','Laboratory created diamonds']) assert.deepEqual(plain(facts.stoneCategories(stone)),['Lab-grown diamonds']);
  assert.deepEqual(plain(facts.stoneCategories('Diamonds')),['Diamonds (origin unspecified)']);
  assert.deepEqual(plain(facts.stoneCategories('CZ simulated diamonds')),['Cubic zirconia']);
  assert.deepEqual(plain(facts.stoneCategories('Earth-mined diamonds and lab-grown diamonds')),['Earth-mined diamonds','Lab-grown diamonds']);
  for(const stone of ['unknown','not natural diamonds','Ruby']) assert.deepEqual(plain(facts.stoneCategories(stone)),[]);
  assert.deepEqual(plain(facts.stoneCategories('No stone')),['No stone']);
});
test('VVS simulated diamonds stay explicitly simulated in the title and categories',()=>{
  const watch={brand:'Cartier',name:'Santos',model:'WSSA0007',modifications:'Aftermarket bezel'};
  assert.equal(facts.watchTitle(watch,'VVS simulated diamonds'),'Cartier Santos WSSA0007 — Aftermarket, VVS simulated diamonds');
  assert.deepEqual(plain(facts.categories('Watches','VVS simulated diamonds',watch)),['Watches','VVS simulated diamonds','Aftermarket']);
  assert.deepEqual(plain(facts.stoneCategories('Simulated diamonds')),['Simulated diamonds']);
});
test('automatic categories retain the chosen item type and do not duplicate categories',()=>{
  assert.deepEqual(plain(facts.categories('Watches','Natural diamonds',{modifications:'Aftermarket bezel'})),['Watches','Earth-mined diamonds','Aftermarket']);
  assert.deepEqual(plain(facts.categories('Earth-mined diamonds','Natural diamonds')),['Earth-mined diamonds']);
  assert.deepEqual(plain(facts.categories('Coins','')),['Coins']);
});
test('changing an existing draft stone selection replaces automatic title qualifiers',()=>{
  const watch={brand:'Cartier',name:'Santos',model:'WSSA0007',modifications:'Aftermarket bezel'};
  const original=facts.watchTitle(watch,'Earth-mined diamonds');
  const revised=facts.watchTitle(watch,'VVS simulated diamonds',original);
  assert.equal(revised,'Cartier Santos WSSA0007 — Aftermarket, VVS simulated diamonds');
  assert.equal(facts.watchTitle({...watch,modifications:''},'',revised),'Cartier Santos WSSA0007');
});

test('descriptions keep facts once across repeated saves and exports',()=>{
  const watch={brand:'Cartier',name:'Santos',model:'WSSA0007',materials:'Stainless steel',modifications:'Aftermarket diamond bezel'};
  const description='Cartier Santos with a stainless steel case and aftermarket diamond bezel, set with natural diamonds.';
  assert.equal(facts.watchDescription(description,watch,'Earth-mined diamonds'),description);
  const enriched=facts.watchDescription('Polished case.\n\nService receipt included.',watch,'VVS simulated diamonds');
  assert.equal(facts.watchDescription(enriched,watch,'VVS simulated diamonds'),enriched);
  assert.equal((enriched.match(/Aftermarket diamond bezel/gi)||[]).length,1);
  assert.equal((enriched.match(/VVS simulated diamonds/gi)||[]).length,1);
  assert.match(enriched,/Service receipt included/);
  assert.doesNotMatch(enriched,/Watch details:|Name:|Model \/ reference:/);
});
test('legacy description blocks and duplicate paragraphs do not accumulate',()=>{
  const watch={name:'Santos',model:'WSSA0007',modifications:'Aftermarket bezel with VVS simulated diamonds'};
  const description='Original box included.\n\nOriginal box included.\n\nWatch details:\nName: Santos\nModel / reference: WSSA0007';
  const result=facts.watchDescription(description,watch,'VVS simulated diamonds');
  assert.equal(result,'Original box included.\n\nAftermarket bezel with VVS simulated diamonds.');
  assert.equal(facts.watchDescription(result,watch,'VVS simulated diamonds'),result);
});
test('aftermarket disclosure remains visible when entered in the watch name',()=>{
  assert.match(facts.watchDescription('A polished watch.',{name:'Aftermarket Santos',modifications:'Replacement bezel'}),/Aftermarket/);
});
