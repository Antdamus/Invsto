import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
const context=vm.createContext({});
vm.runInContext(readFileSync(new URL('../inventory-item-facts.js',import.meta.url),'utf8'),context);
const facts=context.InventoryItemFacts;
const plain=value=>JSON.parse(JSON.stringify(value));

test('watch cards distinguish confirmed presence, confirmed absence and unchecked legacy items',()=>{
  for(const [value,label] of [['yes','Card included'],['no','No card included'],['','Card not checked'],[undefined,'Card not checked'],[true,'Card not checked']]) {
    const watch={brand:'Cartier',model:'WSSA0018',serial:'PRIVATE-123',cardIncluded:value};
    assert.equal(facts.watchCardLabel(watch),label);
    assert.equal(facts.publicWatchDetails(watch).cardIncluded,['yes','no'].includes(value)?value:'');
    assert.equal(facts.publicWatchDetails(watch).serial,undefined);
    const copy=facts.watchDescription('A watch.',watch);
    if(value==='yes') assert.match(copy,/Original brand \/ warranty card included/);
    else if(value==='no') assert.match(copy,/No brand \/ warranty card included/);
    else assert.doesNotMatch(copy,/card/i);
    assert.equal(facts.watchDescription(copy,watch),copy,'Repeated saves are stable');
  }
});

test('changing the watch card removes the previous automatic claim without losing other details',()=>{
  const watch={brand:'Cartier',materials:'Steel case',modificationPreset:'aftermarket_bracelet'};
  const included=facts.watchDescription('Service receipt included.',{...watch,cardIncluded:'yes'});
  const absent=facts.watchDescription(included,{...watch,cardIncluded:'no'});
  assert.doesNotMatch(absent,/Original brand \/ warranty card included/);
  assert.match(absent,/No brand \/ warranty card included/);
  const unchecked=facts.watchDescription(absent,watch);
  assert.doesNotMatch(unchecked,/card included/i);
  assert.match(unchecked,/Service receipt included/);
  assert.match(unchecked,/Steel case/);
  assert.match(unchecked,/Aftermarket bracelet/);
  assert.equal(facts.watchDescription(unchecked,watch),unchecked);
});

test('changing the card choice also replaces common generated card statements',()=>{
  for(const oldClaim of ['No warranty card included.','Without a warranty card.','Brand card is not included.']) {
    const copy=facts.watchDescription(`Polished case. ${oldClaim}`,{cardIncluded:'yes'});
    assert.match(copy,/Polished case/);
    assert.ok(!copy.includes(oldClaim));
    assert.match(copy,/Original brand \/ warranty card included/);
  }
  for(const oldClaim of ['Includes a warranty card.','Original warranty card included.','Accompanied by the brand card.']) {
    const copy=facts.watchDescription(`Polished case. ${oldClaim}`,{cardIncluded:'no'});
    assert.ok(!copy.includes(oldClaim));
    assert.match(copy,/No brand \/ warranty card included/);
    assert.doesNotMatch(facts.watchDescription(copy,{}),/card/i);
  }
});

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

test('movement-only preset follows the brand and remains explicit through repeated saves',()=>{
  for (const brand of ['Cartier','Rolex']) {
    const watch={brand,name:'Watch',model:'MODEL-123',modificationPreset:'movement_only',modifications:'Custom dial'};
    const disclosure=`Only the ${brand} movement is original; all other parts are aftermarket`;
    assert.match(facts.watchTitle(watch),/Aftermarket/);
    const once=facts.watchDescription('Pre-owned watch.',watch);
    assert.ok(once.includes(disclosure));
    assert.equal(facts.watchDescription(once,watch),once);
    const persisted={...watch,modificationNotes:watch.modifications,modifications:facts.watchModifications(watch)};
    assert.equal(facts.watchModifications(persisted),`${disclosure}. Custom dial`);
  }
});

test('separate serial remains private while reference, measured fit and paragraphs survive',()=>{
  const watch={brand:'Cartier',name:'Santos',model:'WSSA0018',serial:'ABC-123',braceletFit:'7 inches',materials:'Steel bezel'};
  assert.equal(facts.watchTitle(watch,'','Cartier Santos ABC-123'),'Cartier Santos WSSA0018');
  const copy=facts.watchDescription('Box included.\n\nABC-123\n\nService receipt included.',watch);
  assert.doesNotMatch(copy,/ABC-123/);
  assert.match(copy,/Box included\.\n/);
  assert.match(copy,/Measured bracelet \/ wrist fit: 7 inches/);
  assert.equal(facts.publicWatchDetails(watch).serial,undefined);
  assert.equal(watch.serial,'ABC-123','Internal source is not mutated');
});

test('a complete paraphrased movement-only disclosure is not repeated',()=>{
  const watch={brand:'Cartier',modificationPreset:'movement_only',modifications:'Custom bracelet'};
  const copy='Cartier Santos featuring the original Cartier movement, with all other parts aftermarket, including a custom bracelet.';
  assert.equal(facts.watchDescription(copy,watch),copy);
  assert.match(facts.watchDescription('A watch with an original Cartier movement and aftermarket bezel.',watch),/all other parts are aftermarket/,'Partial disclosure must still receive the full scope');
});

test('stone setting is independent of diamond origin and survives saves and public metadata',()=>{
  const watch={brand:'Cartier',name:'Santos',model:'WSSA0018',stoneSetting:'aftermarket'};
  const stone='Earth-mined diamonds';
  const title=facts.watchTitle(watch,stone);
  assert.equal(title,'Cartier Santos WSSA0018 — Aftermarket-set stones, Earth-mined diamonds');
  assert.equal(facts.watchTitle(watch,stone,title),title);
  const description=facts.watchDescription('Box included.',watch,stone);
  assert.match(description,/Aftermarket stone setting/);
  assert.match(description,/Earth-mined diamonds/);
  assert.equal(facts.watchDescription(description,watch,stone),description);
  assert.equal(facts.publicWatchDetails(watch,stone).stoneSetting,'aftermarket');
  assert.deepEqual(plain(facts.categories('Watches',stone,watch)),['Watches','Earth-mined diamonds','Aftermarket']);
});

test('factory-set stones can coexist with an aftermarket bracelet, without repeated disclosures',()=>{
  const watch={brand:'Rolex',model:'126233',stoneSetting:'factory',modificationPreset:'aftermarket_bracelet'};
  const description='Factory-set earth-mined diamonds. Aftermarket bracelet / strap.';
  assert.equal(facts.watchDescription(description,watch,'Earth-mined diamonds'),description);
  assert.match(facts.watchTitle(watch,'Earth-mined diamonds'),/Aftermarket, Earth-mined diamonds, Factory-set stones/);
  assert.equal(facts.watchStoneSetting(watch),'factory');
});

test('unknown settings stay unknown and no-stone items ignore stale setting metadata',()=>{
  for (const watch of [{},{stoneSetting:'unknown'},{stoneSetting:'invented'},{modificationPreset:'aftermarket_bracelet'}]) {
    assert.equal(facts.watchStoneSetting(watch,'Earth-mined diamonds'),'unknown');
    assert.doesNotMatch(facts.watchDescription('Watch.',watch,'Earth-mined diamonds'),/Factory-set|Aftermarket stone setting/i);
  }
  const watch={brand:'Rolex',stoneSetting:'aftermarket'};
  assert.equal(facts.watchStoneSetting(watch,'No stone'),'');
  assert.equal(facts.watchTitle(watch,'No stone'),'Rolex');
  assert.deepEqual(plain(facts.categories('Watches','No stone',watch)),['Watches','No stone']);
  assert.doesNotMatch(facts.watchDescription('',watch,'No stone'),/aftermarket|setting/i);
});

test('explicit modification scopes override contradictory setting metadata',()=>{
  for (const modificationPreset of ['movement_only','aftermarket_stones']) {
    const watch={brand:'Cartier',stoneSetting:'factory',modificationPreset};
    assert.equal(facts.watchStoneSetting(watch,'VVS simulated diamonds'),'aftermarket');
    const copy=facts.watchDescription('',watch,'VVS simulated diamonds');
    assert.doesNotMatch(copy,/factory-set/i);
    assert.match(copy,/Aftermarket stone setting/i);
    assert.equal((copy.match(/Aftermarket stone setting/gi)||[]).length,1);
  }
});
