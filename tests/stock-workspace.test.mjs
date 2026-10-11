import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context={};
vm.runInNewContext(await readFile(new URL('../inventory-item-facts.js',import.meta.url),'utf8'),context);
vm.runInNewContext(await readFile(new URL('../stock-workspace.js',import.meta.url),'utf8'),context);
const {watchDraft}=context.StockWorkspace;
test('basic or empty descriptions need review without flagging concise written descriptions',()=>{
 const review=context.StockWorkspace.descriptionNeedsReview;
 assert.equal(review({description:''}),true);
 assert.equal(review({watch_details:{model:'WSSA0062'},description:'Santos de Cartier, model / reference WSSA0062. Stones: Earth-mined diamonds.'}),true);
 assert.equal(review({watch_details:{},description:'An iced-out square watch with red Roman numerals.'}),false);
});
test('editing a watch retains private metadata and regenerates changed modification disclosures',()=>{
 const before={brand:'Cartier',model:'WSSA0018',serial:'PRIVATE-1',modificationPreset:'movement_only',modificationNotes:'',modifications:'Only the Cartier movement is original; all other parts are aftermarket',stoneSetting:'aftermarket',referenceLookup:{facts:[]},customField:'preserved'};
 const next=watchDraft(before,{modificationPreset:'aftermarket_bracelet',modificationNotes:'Black replacement strap',stoneSetting:'factory',cardIncluded:'yes'},'Earth-mined diamonds');
 assert.equal(next.serial,'PRIVATE-1');assert.equal(next.customField,'preserved');assert.equal(next.cardIncluded,'yes');
 assert.equal(next.modifications,'Aftermarket bracelet / strap. Black replacement strap');assert.equal(next.stoneSetting,'factory');
 assert.ok(next.referenceLookup);assert.equal(before.modificationPreset,'movement_only');
});
test('a changed reference discards stale research, while movement-only scope overrides setting conflicts',()=>{
 const next=watchDraft({brand:'Cartier',model:'OLD',referenceLookup:{facts:['old model']}},{model:'NEW',modificationPreset:'movement_only',stoneSetting:'factory',modificationNotes:''},'Lab-grown diamonds');
 assert.equal(next.referenceLookup,undefined);assert.equal(next.stoneSetting,'aftermarket');
 assert.equal(next.modifications,'Only the Cartier movement is original; all other parts are aftermarket');
 const noStones=watchDraft(next,{},'No stone');assert.equal(noStones.stoneSetting,'');
});
