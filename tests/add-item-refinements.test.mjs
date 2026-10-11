import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

function pricing() {
  const controls = new Map();
  const get = id => {
    if (!controls.has(id)) controls.set(id, {value:'',checked:false,disabled:false,events:{},
      addEventListener(type,fn){this.events[type]=fn;}, closest(){return {};},
      checkValidity(){return !this.required || (this.value!=='' && Number(this.value)>=0.01 && Number(this.value)<=1 && Number.isInteger(Math.round(Number(this.value)*10000)/100));},
    });
    return controls.get(id);
  };
  get('item-pricing-mode').value='later';get('item-auto-minimum').checked=true;get('item-break-even-factor').value='0.70';
  const window={}, document={getElementById:get,querySelector:()=>({}),addEventListener(){},dispatchEvent(){}};
  vm.runInNewContext(read('additem-pricing.js'),{window,document,Event});
  const input=(id,value)=>{get(id).value=String(value);get(id).events.input?.();};
  const mode=value=>{get('item-pricing-mode').value=value;get('item-pricing-mode').events.change();};
  return {get,input,mode,api:window.addItemPricing};
}
test('break-even follows cost and divisor, but an explicit price survives later cost changes',()=>{
  const p=pricing();p.mode('now');p.input('cost',70);
  assert.equal(p.get('minimum-sale-price').value,'100.00');
  p.input('item-break-even-factor',0.8);assert.equal(p.get('minimum-sale-price').value,'87.50');
  p.input('minimum-sale-price',92);p.input('cost',140);
  assert.equal(p.get('minimum-sale-price').value,'92');assert.equal(p.get('item-auto-minimum').checked,false);
  p.get('item-auto-minimum').checked=true;p.get('item-auto-minimum').events.change();
  assert.equal(p.get('minimum-sale-price').value,'175.00');
});
test('deferred pricing stays blank; zero/invalid/cleared costs and divisors cannot retain a stale calculated price',()=>{
  const p=pricing();p.input('cost',70);assert.equal(p.get('minimum-sale-price').value,'');
  p.mode('now');p.input('cost',0);assert.equal(p.get('minimum-sale-price').value,'0.00');
  p.input('cost','');assert.equal(p.get('minimum-sale-price').value,'');
  p.input('cost',100);assert.equal(p.get('minimum-sale-price').value,'142.86');
  p.input('item-break-even-factor',0);assert.equal(p.get('minimum-sale-price').value,'');
  assert.equal(p.get('item-break-even-factor').checkValidity(),false);
});
test('drafts preserve the divisor and manual choice; legacy entered floors are not overwritten',()=>{
  const p=pricing();p.mode('now');p.input('cost',70);p.input('item-break-even-factor',0.5);
  const draft=p.api.getDraft();p.api.restore(draft);assert.equal(p.get('minimum-sale-price').value,'140.00');
  p.input('minimum-sale-price',155);const manual=p.api.getDraft();p.api.restore(manual);
  assert.equal(p.get('minimum-sale-price').value,'155');assert.equal(p.get('item-auto-minimum').checked,false);
  p.api.restore({mode:'now'});assert.equal(p.get('minimum-sale-price').value,'155');
  assert.equal(p.get('item-break-even-factor').value,'0.70');
});

function photos() {
  const counters={inference:0,saves:0,uploads:0,fail:false};
  const elements={bgStatus:{textContent:'',classList:{remove(){},add(){}}}};
  const window={supabase:{functions:{invoke:async()=>{
    if(counters.fail)return {error:{message:'Upload unavailable'}};
    counters.uploads++;return {data:{ok:true,path:`processed-${counters.uploads}`,bucket:'InventoryUpload',previewUrl:'test:photo'}};
  }}},requestIdleCallback:fn=>fn()};
  const source=read('additem-assisted.js').replace('  document.addEventListener("DOMContentLoaded", init);', `
    loadBackgroundRemoval=async()=>({
      preload:async(config)=>{counters.preloadConfig=config;},
      removeBackground:async(blob,config)=>{counters.inference++;counters.inferenceConfig=config;return blob;}
    });
    createScaledSourceBlobForBackgroundRemoval=async()=>new Blob(['cutout']);
    createCompositedBackgroundBlob=async blob=>blob;
    readBlobAsDataUrl=async()=>'data:image/png;base64,dGVzdA==';
    setBackgroundProcessingBusy=()=>{};
    setAISelectedImage=(elements,path)=>{state.aiSelectedUploadedImagePath=path;};
    updateSaveSelectionSummary=()=>{};renderUploadedImages=()=>{};
    persistAddItemDraft=async()=>{counters.saves++;};
    getFunctionErrorDetail=async error=>error.message;
    window.testPhotos={state,processImageBackgroundForImage,preloadBackgroundRemoval};
  `);
  vm.runInNewContext(source,{window,document:{addEventListener(){}},console:{error(){},warn(){}},Blob,counters});
  const a={path:'original-a',name:'Front',storageBucket:'InventoryUpload',previewUrl:'test:a'},b={path:'original-b',name:'Back',storageBucket:'InventoryUpload',previewUrl:'test:b'};
  const api=window.testPhotos;api.state.recentUploadedImages=[a,b];api.state.saveSelectedUploadedImagePaths=[a.path,b.path];
  return {api,counters,elements,a,b};
}
test('background processing replaces only its original selection and reuses the cutout when changing color',async()=>{
  const p=photos();p.api.preloadBackgroundRemoval(p.elements);
  const black=await p.api.processImageBackgroundForImage(p.elements,p.a,'black');
  assert.deepEqual([...p.api.state.saveSelectedUploadedImagePaths],['processed-1','original-b']);
  assert.ok(p.api.state.recentUploadedImages.some(image=>image.path===p.a.path));
  assert.equal(p.api.state.aiSelectedUploadedImagePath,black.path);
  await p.api.processImageBackgroundForImage(p.elements,black,'white');
  assert.deepEqual([...p.api.state.saveSelectedUploadedImagePaths],['processed-2','original-b']);
  assert.equal(p.counters.inference,1,'recoloring must not run segmentation again');
  assert.equal(p.counters.preloadConfig,p.counters.inferenceConfig,'preloading warms the same model session');
  assert.equal(p.counters.saves,2);
});
test('a failed processing upload preserves the original selection and retries with the cached cutout',async()=>{
  const p=photos();p.counters.fail=true;
  assert.equal(await p.api.processImageBackgroundForImage(p.elements,p.a,'black'),null);
  assert.deepEqual([...p.api.state.saveSelectedUploadedImagePaths],['original-a','original-b']);
  assert.equal(p.counters.saves,0);
  p.counters.fail=false;await p.api.processImageBackgroundForImage(p.elements,p.a,'black');
  assert.equal(p.counters.inference,1);assert.equal(p.counters.saves,1);
});
