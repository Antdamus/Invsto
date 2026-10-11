import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const editor = require('../item-photo-editor.js');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const image = { naturalWidth: 1600, naturalHeight: 2200 };
test('initial fit shows the entire portrait; rotated Fit accounts for all four corners', () => {
  const state = editor.initial(), rect = editor.drawRect(image, state, 900, 900);
  near(rect.height, 900); assert.ok(rect.width < 900);
  state.tilt = 35; state.offsetX = 50; state.zoom = 3;
  const fitted = editor.fit(image, state, 900, 900), r = editor.drawRect(image, fitted, 900, 900);
  const radians = 35 * Math.PI / 180;
  assert.ok(r.width * Math.cos(radians) + r.height * Math.sin(radians) <= 900.00001);
  assert.ok(r.height * Math.cos(radians) + r.width * Math.sin(radians) <= 900.00001);
  assert.equal(fitted.offsetX, 0); assert.equal(fitted.tilt, 35);
});
test('pinching keeps the image point anchored while fingers move apart and pan', () => {
  const s = { ...editor.initial(), offsetX: 30, offsetY: -20 };
  const next = editor.gesture(s, [{x:250,y:350},{x:450,y:350}], [{x:100,y:400},{x:500,y:400}], 900, 900);
  near(next.zoom, 2);
  const sourceX = (350 - 450 - s.offsetX) / s.zoom;
  const sourceY = (350 - 450 - s.offsetY) / s.zoom;
  near(450 + next.offsetX + sourceX * next.zoom, 300);
  near(450 + next.offsetY + sourceY * next.zoom, 400);
});
test('zoom limits still use the actual scale ratio, including pinching below the original fit', () => {
  const next = editor.zoomAt(editor.initial(), .1, {x:200,y:300}, {x:200,y:300}, 900, 900);
  assert.equal(next.zoom, .25); near(450 + next.offsetX + (200 - 450) * .25, 200);
  assert.equal(editor.clampZoom(20), 6);
});
test('one finger continues panning after a pinch without jumping; coincident fingers stay finite', () => {
  const s = { ...editor.initial(), zoom: 2, offsetX: 70 };
  const next = editor.gesture(s,[{x:400,y:400}],[{x:420,y:430}],900,900);
  near(next.offsetX,90); near(next.offsetY,30); near(next.zoom,2);
  const same = editor.gesture(s,[{x:400,y:400},{x:400,y:400}],[{x:400,y:400},{x:400,y:400}],900,900);
  assert.ok(Number.isFinite(same.offsetX)); assert.equal(same.zoom,2);
});
test('export resolution follows the source, never the preview, with bounded phone memory', () => {
  assert.equal(editor.outputSize(image), 2200);
  assert.equal(editor.outputSize({width:600,height:800}), 1200);
  assert.equal(editor.outputSize({width:8000,height:6000}), 4096);
  const calls = [], context = new Proxy({}, {get:(_,key)=>(...args)=>calls.push([key,...args]),set:()=>true});
  editor.render(context, image, {...editor.initial(),offsetX:90,offsetY:-45},2200,2200,900);
  assert.deepEqual(calls.find(row=>row[0]==='translate'),['translate',1320,990]);
  assert.equal(calls.find(row=>row[0]==='drawImage')[1],image);
});
test('neutral adjustments are lossless and never change transparency', () => {
  const data = new Uint8ClampedArray([0,0,0,0,50,100,200,128,255,255,255,255]);
  assert.deepEqual(editor.adjustPixels(data.slice(),3,1,editor.initial()),data);
  const adjusted = editor.adjustPixels(data.slice(),3,1,{...editor.initial(),brightness:15,contrast:20,warmth:20,sharpness:60});
  assert.deepEqual([adjusted[3],adjusted[7],adjusted[11]],[0,128,255]);
  assert.deepEqual([...adjusted.slice(0,4)],[0,0,0,0]);
});
test('sharpening brings out detail without changing uniform areas or transparent edges', () => {
  const data = new Uint8ClampedArray(5*5*4).fill(100); for(let i=3;i<data.length;i+=4)data[i]=255;
  const s = {...editor.initial(),sharpness:60};
  assert.deepEqual(editor.adjustPixels(data.slice(),5,5,s),data);
  data[48]=data[49]=data[50]=150;
  assert.ok(editor.adjustPixels(data.slice(),5,5,s)[48]>150);
  data[47]=0;
  assert.equal(editor.adjustPixels(data.slice(),5,5,s)[48],150);
});

function mounted() {
  const elements = new Map(), raf = [], captures = new Set();
  const element = key => {
    if(!elements.has(key)) elements.set(key,{id:`assisted-editor-${key}`,value:'',disabled:false,hidden:false,attrs:{},events:{},
      addEventListener(type,handler){(this.events[type] ||= []).push(handler);},
      fire(type,event={}){for(const handler of this.events[type]||[])handler({preventDefault(){},stopPropagation(){},...event});},
      setAttribute(name,value){this.attrs[name]=value;}, focus(){document.activeElement=this;},getClientRects(){return [1];},
      classList:{add(){},remove(){}},contains(){return false;},
    });
    return elements.get(key);
  };
  const canvas = element('canvas'); canvas.width=canvas.height=900; canvas.parentElement=element('wrap');
  canvas.getBoundingClientRect=()=>({left:10,top:20,width:300,height:300});
  canvas.setPointerCapture=id=>captures.add(id);canvas.hasPointerCapture=id=>captures.has(id);canvas.releasePointerCapture=id=>captures.delete(id);
  const context=new Proxy({},{get:()=>()=>{},set:()=>true});canvas.getContext=()=>context;
  const root=element('root');root.querySelector=selector=>element(selector.replace('#assisted-editor-',''));
  root.querySelectorAll=()=>[...elements.values()].filter(el=>el!==root && el!==canvas);
  const document={body:{children:[root,element('page')]},activeElement:element('opener'),addEventListener(){},createElement:()=>({getContext:()=>context})};
  const window={addEventListener(){}};
  vm.runInNewContext(readFileSync(new URL('../item-photo-editor.js',import.meta.url),'utf8'),{window,document,requestAnimationFrame:fn=>{raf.push(fn);return raf.length;},cancelAnimationFrame(){},Uint8ClampedArray});
  let saved=0,closed=0;
  const api=window.ItemPhotoEditor.mount(root,{onClose:()=>closed++,onSave:()=>saved++});
  api.open('black');api.load(image);
  const pointer=(type,id,x,y)=>canvas.fire(type,{pointerId:id,pointerType:'touch',clientX:x,clientY:y});
  return {api,element,canvas,pointer,captures,document,counts:()=>({saved,closed})};
}
test('real handlers track both pointers, capture cancellation, undo a gesture and redo it', () => {
  const m=mounted();m.pointer('pointerdown',1,110,120);m.pointer('pointerdown',2,210,120);
  m.pointer('pointermove',2,260,120);assert.equal(m.element('zoom-value').textContent,'150%');
  m.pointer('pointerup',2,260,120);m.pointer('pointermove',1,120,140);m.pointer('pointercancel',1,120,140);
  assert.equal(m.captures.size,0);assert.equal(m.element('undo').disabled,false);
  m.element('undo').fire('click');assert.equal(m.element('zoom-value').textContent,'100%');
  m.element('redo').fire('click');assert.equal(m.element('zoom-value').textContent,'150%');
});
test('slider edits form one undo step, reset colors preserves crop, busy locks save/close', () => {
  const m=mounted();m.element('zoom-in').fire('click');
  const zoom=m.element('zoom-value').textContent;
  for(const value of [2,5,12]){m.element('brightness').value=value;m.element('brightness').fire('input');}
  m.element('brightness').fire('change');
  m.element('undo').fire('click');assert.equal(m.element('brightness-value').textContent,'0');
  m.element('redo').fire('click');assert.equal(m.element('brightness-value').textContent,'+12');
  m.element('reset-adjustments').fire('click');assert.equal(m.element('zoom-value').textContent,zoom);
  m.api.setBusy(true);m.element('save').fire('click');m.element('close').fire('click');assert.deepEqual(m.counts(),{saved:0,closed:0});
  m.api.setBusy(false);m.element('save').fire('click');assert.equal(m.counts().saved,1);
});
test('reopening clears history and comparison, restores focus and starts on Frame', () => {
  const m=mounted();m.element('tab-adjust').fire('click');m.element('compare').fire('click');
  m.element('zoom-in').fire('click');m.api.close();
  assert.equal(m.element('page').inert,undefined);assert.equal(m.document.activeElement,m.element('opener'));
  m.api.open('white');m.api.load(image);
  assert.equal(m.element('panel-adjust').hidden,true);assert.equal(m.element('undo').disabled,true);
  assert.equal(m.element('compare').attrs['aria-pressed'],'false');assert.equal(m.element('fill-white').attrs['aria-pressed'],'true');
});

function intake() {
  const counters={loads:[],revoked:[],uploads:0,fail:false,hold:null,saves:0};
  const photo={path:'original.png',previewUrl:'source:full',storageBucket:'photos',name:'Original'};
  const button={disabled:false};
  const classes={add(){},remove(){}};
  const elements={imageEditorModal:{classList:classes,setAttribute(){}},imageEditorSave:button,imageEditorStatus:{},bgStatus:{}};
  const mounted={open(){},load(image){counters.loads.push(image);},close(){},setBusy(){},exportCanvas:()=>({source:'full-resolution'})};
  const window={ItemPhotoEditor:{mount:()=>mounted},supabase:{functions:{invoke:async()=>{
    counters.uploads++;if(counters.fail)return {error:{message:'Offline'}};
    return {data:{ok:true,path:'edited.png',bucket:'photos',previewUrl:'source:edited'}};
  }}}};
  const source=readFileSync(new URL('../additem-assisted.js',import.meta.url),'utf8').replace('  document.addEventListener("DOMContentLoaded", init);', `
    createObjectUrlForCanvas=async url=>({imageUrl:url,revoke:()=>counters.revoked.push(url)});
    loadImageElement=async url=>{if(counters.hold)await counters.hold;return {url,naturalWidth:2200,naturalHeight:1600};};
    canvasToBlob=async canvas=>{if(canvas.source!=='full-resolution')throw Error('Wrong source');return new Blob(['PNG'],{type:'image/png'});};
    readBlobAsDataUrl=async()=>'data:image/png;base64,UE5H';
    setInlineStatus=(target,text)=>{target.textContent=text;};
    setButtonBusy=()=>{};getFunctionErrorDetail=async error=>error.message;
    setAISelectedImage=(elements,path)=>{state.aiSelectedUploadedImagePath=path;};
    updateSaveSelectionSummary=()=>{};renderUploadedImages=()=>{};scheduleAddItemDraftSave=()=>{};
    persistAddItemDraft=async()=>{counters.saves++;};
    window.testing={state,openImageEditor,closeImageEditor,saveImageEditorCrop};
  `);
  vm.runInNewContext(source,{window,document:{body:{classList:classes},addEventListener(){}},console:{error(){}},counters,Blob,setTimeout,requestAnimationFrame:fn=>queueMicrotask(fn)});
  const api=window.testing;api.state.aiSelectedUploadedImage=photo;api.state.recentUploadedImages=[photo,{path:'back.png'}];api.state.saveSelectedUploadedImagePaths=['original.png','back.png'];
  return {api,counters,elements,photo};
}
test('closing during loading discards the late image and releases its object URL',async()=>{
  const t=intake();let release;t.counters.hold=new Promise(resolve=>release=resolve);
  const opened=t.api.openImageEditor(t.elements);t.api.closeImageEditor(t.elements);release();await opened;
  assert.equal(t.counters.loads.length,0);assert.deepEqual(t.counters.revoked,['source:full']);
  assert.equal(t.api.state.imageEditor.image,null);
});
test('save failure preserves original selection and edits; retry replaces only that photo',async()=>{
  const t=intake();await t.api.openImageEditor(t.elements);t.counters.fail=true;
  await t.api.saveImageEditorCrop(t.elements);
  assert.deepEqual([...t.api.state.saveSelectedUploadedImagePaths],['original.png','back.png']);
  assert.equal(t.api.state.imageEditor.image,t.photo);assert.equal(t.elements.imageEditorStatus.textContent,'Offline');
  t.counters.fail=false;await t.api.saveImageEditorCrop(t.elements);
  assert.deepEqual([...t.api.state.saveSelectedUploadedImagePaths],['edited.png','back.png']);
  assert.ok(t.api.state.recentUploadedImages.includes(t.photo));assert.equal(t.counters.saves,1);
});
test('double save requests upload one edited image',async()=>{
  const t=intake();await t.api.openImageEditor(t.elements);
  await Promise.all([t.api.saveImageEditorCrop(t.elements),t.api.saveImageEditorCrop(t.elements)]);
  assert.equal(t.counters.uploads,1);assert.equal(t.counters.saves,1);
});
