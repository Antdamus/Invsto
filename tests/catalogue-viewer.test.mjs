import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context={};vm.runInNewContext(await readFile(new URL('../catalogue-viewer.js',import.meta.url),'utf8'),context);
const {fit,bound,anchored,MAX_ZOOM}=context.CataloguePhotoGeometry;
const near=(a,b)=>assert.ok(Math.abs(a-b)<.00001,`${a} should equal ${b}`);
test('portrait and landscape originals fit without cropping or changing their proportions',()=>{
 for(const [iw,ih,w,h] of [[2400,3200,390,600],[4000,2000,1200,700],[1000,1000,320,220]]){
  const result=fit(iw,ih,w,h);assert.ok(result.width<=w-24);assert.ok(result.height<=h-24);near(result.width/result.height,iw/ih);
 }
});
test('scroll zoom keeps the same detail under the pointer and reversing restores the view',()=>{
 const s={scale:2,x:35,y:-18},p={x:150,y:-80},next=anchored(s,5,p);
 near((p.x-next.x)/next.scale,(p.x-s.x)/s.scale);near((p.y-next.y)/next.scale,(p.y-s.y)/s.scale);
 const back=anchored(next,2,p);near(back.x,s.x);near(back.y,s.y);
});
test('a moving pinch tracks both magnification and finger position',()=>{
 const start={scale:1,x:0,y:0},from={x:30,y:50},to={x:65,y:10},next=anchored(start,3,from,to);
 near((to.x-next.x)/next.scale,30);near((to.y-next.y)/next.scale,50);
});
test('dragging cannot lose the photo off screen, and fit recenters both axes',()=>{
 const base={width:300,height:400},viewport={width:390,height:500};
 const p=bound({scale:3,x:99999,y:-99999},base,viewport);assert.equal(p.x,255);assert.equal(p.y,-350);
 const fitted=bound({...p,scale:1},base,viewport);near(fitted.x,0);near(fitted.y,0);
});
test('extreme input stays finite and provides magnification well beyond original screen size',()=>{
 const next=anchored({scale:1,x:0,y:0},Infinity,{x:200,y:300});assert.equal(next.scale,MAX_ZOOM);assert.ok(MAX_ZOOM>=32);
 assert.ok(Number.isFinite(next.x)&&Number.isFinite(next.y));assert.equal(anchored(next,0,{x:0,y:0}).scale,1);
});
