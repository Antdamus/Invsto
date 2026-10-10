(function (root) {
 'use strict';
 const MAX_ZOOM=64;
 const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
 function fit(iw,ih,w,h){const ratio=Math.min((w-24)/iw,(h-24)/ih);return{width:iw*Math.max(0,ratio),height:ih*Math.max(0,ratio)};}
 function bound(s,base,viewport){
  const scale=clamp(s.scale,1,MAX_ZOOM),x=Math.max(0,(base.width*scale-viewport.width)/2),y=Math.max(0,(base.height*scale-viewport.height)/2);
  return{scale,x:clamp(s.x,-x,x),y:clamp(s.y,-y,y)};
 }
 // Keep the point under the cursor/fingers stationary, even while a pinch moves.
 function anchored(s,scale,from,to=from){const next=clamp(scale,1,MAX_ZOOM),ratio=next/s.scale;return{scale:next,x:to.x-(from.x-s.x)*ratio,y:to.y-(from.y-s.y)*ratio};}
 root.CataloguePhotoGeometry={fit,bound,anchored,MAX_ZOOM};
 if(!root.document)return;
 const C=root.Catalogue;
 let dialog,stage,photo,controls,heading,counter,zoomLabel,thumbs,status,ready=false,origin=null,images=[],index=0;
 let state={scale:1,x:0,y:0},base={width:0,height:0},viewport={width:0,height:0},gesture=null,moved=false,multi=false,lastTap=null;
 const pointers=new Map();
 function paint(){
  state=bound(state,base,viewport);
  photo.style.transform=`translate(-50%, -50%) translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
  stage.classList.toggle('is-zoomed',state.scale>1.001);
  zoomLabel.textContent=`${Math.round(state.scale*100)}%`;
  controls.querySelector('[data-viewer="out"]').disabled=!ready||state.scale<=1;
  controls.querySelector('[data-viewer="in"]').disabled=!ready||state.scale>=MAX_ZOOM;
  controls.querySelector('[data-viewer="fit"]').disabled=!ready;
 }
 function measure(){
  if(!ready||!dialog.open)return;
  const rect=stage.getBoundingClientRect(),old=base;
  viewport={width:rect.width,height:rect.height};base=fit(photo.naturalWidth,photo.naturalHeight,rect.width,rect.height);
  photo.style.width=`${base.width}px`;photo.style.height=`${base.height}px`;
  if(old.width){state.x*=base.width/old.width;state.y*=base.height/old.height;}
  paint();seed();
 }
 function reset(){state={scale:1,x:0,y:0};lastTap=null;paint();}
 function zoom(scale,point={x:0,y:0}){if(!ready)return;state=anchored(state,scale,point);paint();}
 function point(event){const r=stage.getBoundingClientRect();return{x:event.clientX-r.left-r.width/2,y:event.clientY-r.top-r.height/2};}
 function center(points){return points.length>1?{x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2}:points[0];}
 function distance(points){return points.length>1?Math.hypot(points[1].x-points[0].x,points[1].y-points[0].y):0;}
 function seed(){const pts=[...pointers.values()];gesture=pts.length?{...state,center:center(pts),distance:distance(pts)}:null;}
 function clearGesture(){pointers.clear();gesture=null;moved=false;multi=false;lastTap=null;stage?.classList.remove('is-dragging');}
 function showPhoto(n){
  clearGesture();index=clamp(n,0,images.length-1);ready=false;state={scale:1,x:0,y:0};base={width:0,height:0};
  photo.hidden=true;status.hidden=false;status.textContent='Loading photograph…';stage.setAttribute('aria-busy','true');
  counter.textContent=`Photo ${index+1} of ${images.length}`;
  photo.alt=`${heading.textContent} — photo ${index+1}`;
  thumbs.querySelectorAll('button').forEach((b,n)=>b.setAttribute('aria-pressed',String(n===index)));
  controls.querySelector('[data-viewer="previous"]').disabled=index===0;
  controls.querySelector('[data-viewer="next"]').disabled=index===images.length-1;
  paint();photo.src=images[index];
 }
 function create(){
  dialog=document.createElement('dialog');dialog.id='catalogue-photo-viewer';dialog.className='photo-viewer';
  dialog.setAttribute('aria-labelledby','viewer-title');
  dialog.innerHTML=`<header class="viewer-header"><div><p class="eyebrow">THE FINER DETAILS</p><h2 id="viewer-title"></h2><p id="viewer-counter"></p></div><button type="button" class="viewer-close" aria-label="Close photo viewer" autofocus>✕</button></header><div class="viewer-stage" tabindex="0" aria-label="Zoomable piece photograph" aria-describedby="viewer-help"><img class="viewer-photo" alt="" draggable="false"><p class="viewer-status" role="status"></p></div><footer class="viewer-footer"><div class="viewer-thumbnails" aria-label="Choose a photograph"></div><div class="viewer-controls"><button type="button" data-viewer="previous" aria-label="Previous photograph">‹</button><div class="viewer-zoom-controls"><button type="button" data-viewer="out" aria-label="Zoom out">−</button><output aria-label="Zoom level">100%</output><button type="button" data-viewer="in" aria-label="Zoom in">＋</button><button type="button" data-viewer="fit">Fit</button></div><button type="button" data-viewer="next" aria-label="Next photograph">›</button></div><p id="viewer-help"><span class="viewer-desktop-help">Scroll or click to zoom · Drag to explore</span><span class="viewer-touch-help">Pinch or double-tap to zoom · Drag to explore</span></p></footer>`;
  document.body.append(dialog);
  stage=dialog.querySelector('.viewer-stage');photo=dialog.querySelector('.viewer-photo');heading=dialog.querySelector('h2');counter=dialog.querySelector('#viewer-counter');
  controls=dialog.querySelector('.viewer-controls');zoomLabel=controls.querySelector('output');thumbs=dialog.querySelector('.viewer-thumbnails');status=dialog.querySelector('.viewer-status');
  photo.addEventListener('load',()=>{if(!dialog.open)return;ready=true;photo.hidden=false;status.hidden=true;stage.setAttribute('aria-busy','false');measure();});
  photo.addEventListener('error',()=>{if(!dialog.open)return;ready=false;photo.hidden=true;stage.setAttribute('aria-busy','false');status.hidden=false;status.textContent='This photograph could not load. Close the viewer and try again.';paint();});
  dialog.querySelector('.viewer-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{ready=false;clearGesture();photo.removeAttribute('src');document.body.classList.remove('photo-viewer-open');if(origin?.isConnected)origin.focus({preventScroll:true});});
  controls.addEventListener('click',e=>{
   const action=e.target.closest('button')?.dataset.viewer;
   if(action==='in')zoom(state.scale*1.5);if(action==='out')zoom(state.scale/1.5);if(action==='fit')reset();
   if(action==='next')showPhoto(index+1);if(action==='previous')showPhoto(index-1);
  });
  thumbs.addEventListener('click',e=>{const b=e.target.closest('[data-viewer-photo]');if(b)showPhoto(Number(b.dataset.viewerPhoto));});
  stage.addEventListener('wheel',e=>{e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?viewport.height:1;zoom(state.scale*Math.exp(clamp(-e.deltaY*unit*.002,-1,1)),point(e));},{passive:false});
  stage.addEventListener('pointerdown',e=>{
   if(!ready||(e.pointerType==='mouse'&&e.button!==0))return;
   e.preventDefault();stage.focus({preventScroll:true});
   if(!pointers.size){moved=false;multi=false;}
   pointers.set(e.pointerId,point(e));stage.setPointerCapture(e.pointerId);
   if(pointers.size>1){multi=true;lastTap=null;}
   stage.classList.add('is-dragging');seed();
  });
  stage.addEventListener('pointermove',e=>{
   if(!pointers.has(e.pointerId)||!gesture)return;e.preventDefault();pointers.set(e.pointerId,point(e));
   const pts=[...pointers.values()],mid=center(pts),d=distance(pts);
   if(Math.hypot(mid.x-gesture.center.x,mid.y-gesture.center.y)>4||pts.length>1)moved=true;
   const scale=gesture.distance>0&&pts.length>1?gesture.scale*d/gesture.distance:gesture.scale;
   state=anchored(gesture,scale,gesture.center,mid);paint();
  });
  function endPointer(e,cancelled=false){
   if(!pointers.has(e.pointerId))return;
   const p=point(e),tap=!cancelled&&!moved&&!multi&&pointers.size===1;
   pointers.delete(e.pointerId);if(stage.hasPointerCapture(e.pointerId))stage.releasePointerCapture(e.pointerId);seed();
   if(!pointers.size)stage.classList.remove('is-dragging');
   if(!tap)return;
   if(e.pointerType==='mouse'){zoom(state.scale>1.001?1:2.5,p);return;}
   const now=performance.now();
   if(lastTap&&now-lastTap.time<320&&Math.hypot(p.x-lastTap.x,p.y-lastTap.y)<30){zoom(state.scale>1.001?1:2.5,p);lastTap=null;}
   else lastTap={...p,time:now};
  }
  stage.addEventListener('pointerup',e=>endPointer(e));stage.addEventListener('pointercancel',e=>endPointer(e,true));stage.addEventListener('lostpointercapture',e=>endPointer(e,true));
  dialog.addEventListener('keydown',e=>{
   if(e.ctrlKey||e.metaKey||e.altKey)return;
   if(['+','=','-','0','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))e.preventDefault();
   if(e.key==='+'||e.key==='=')zoom(state.scale*1.5);if(e.key==='-')zoom(state.scale/1.5);if(e.key==='0')reset();
   if(e.key.startsWith('Arrow')){
    if(state.scale>1){const d={ArrowLeft:[80,0],ArrowRight:[-80,0],ArrowUp:[0,80],ArrowDown:[0,-80]}[e.key];if(d){state.x+=d[0];state.y+=d[1];paint();}}
    else if(e.key==='ArrowLeft'&&index>0)showPhoto(index-1);else if(e.key==='ArrowRight'&&index<images.length-1)showPhoto(index+1);
   }
  });
  new ResizeObserver(measure).observe(stage);
 }
 root.CatalogueViewer={
  get isOpen(){return Boolean(dialog?.open);},
  close(){if(dialog?.open)dialog.close();},
  open(item,start=0,trigger=document.activeElement){
   const sources=(item.images||[]).map(C.safeImage).filter(Boolean);if(!sources.length)return false;
   if(!dialog)create();origin=trigger;images=sources;heading.textContent=item.name;
   thumbs.innerHTML=images.map((src,n)=>`<button type="button" data-viewer-photo="${n}" aria-label="View photograph ${n+1}" aria-pressed="false"><img src="${C.escape(src)}" alt="" loading="lazy"></button>`).join('');
   thumbs.hidden=images.length<2;controls.querySelectorAll('[data-viewer="previous"],[data-viewer="next"]').forEach(b=>b.hidden=images.length<2);
   document.body.classList.add('photo-viewer-open');if(!dialog.open)dialog.showModal();showPhoto(start);return true;
  }
 };
})(typeof window==='undefined'?globalThis:window);
