/* One-shot, user-selected window capture for Windows Media Engine video surfaces. */
(function(){
 'use strict';
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 globalThis.ogTikTokWindowCapture=async function({video,valid,overlays}){
  // Must be called directly by a click: permission is never requested in the background.
  if(!navigator.mediaDevices?.getDisplayMedia)throw Error('Window capture is unavailable in this browser.');
  const pending=navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'window',frameRate:5},audio:false});
  video.pause();let stream,screenVideo,markers,timer;const visibility=overlays.map(el=>el.style.visibility);
  try{
   stream=await pending;timer=setTimeout(()=>stream.getTracks().forEach(t=>t.stop()),15000);
   if(!valid()||document.visibilityState!=='visible')throw Error('Return to the same TikTok receipt and capture again.');
   const rect=video.getBoundingClientRect();
   if(rect.left<12||rect.top<12||rect.right+14>innerWidth||rect.bottom+14>innerHeight)throw Error('Exit fullscreen and keep a little space around the whole video, then capture again.');
   const random=crypto.getRandomValues(new Uint8Array(4));
   const colors=[[245,20+random[0]%80,235],[15,230,30+random[1]%80],[20+random[2]%80,35,245],[240,220,20+random[3]%80]];
   markers=document.createElement('div');markers.id='og-tiktok-window-markers';markers.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none';
   const root=markers.attachShadow({mode:'closed'});
   [[rect.left-12,rect.top-12],[rect.right+2,rect.top-12],[rect.left-12,rect.bottom+2],[rect.right+2,rect.bottom+2]].forEach(([x,y],i)=>{const dot=document.createElement('div');dot.style.cssText=`position:absolute;left:${x}px;top:${y}px;width:12px;height:12px;background:rgb(${colors[i].join(',')});`;root.append(dot);});
   overlays.forEach(el=>el.style.visibility='hidden');document.documentElement.append(markers);
   screenVideo=document.createElement('video');screenVideo.muted=true;screenVideo.srcObject=stream;
   await Promise.race([screenVideo.play(),wait(5000).then(()=>{throw Error('The selected window did not provide a frame.');})]);
   let canvas,crop,lastError;
   for(let attempt=0;attempt<12;attempt++){
    await wait(200);
    const now=video.getBoundingClientRect();
    if(!valid()||document.visibilityState!=='visible'||['x','y','width','height'].some(k=>Math.abs(now[k]-rect[k])>1))throw Error('The receipt changed during capture. Try again.');
    const w=screenVideo.videoWidth,h=screenVideo.videoHeight;
    if(!w||!h)continue;if(w*h>16777216)throw Error('Choose just the browser window instead of the entire desktop.');
    canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(screenVideo,0,0);
    try{crop=ogTikTokReceiptImage.locate(ctx.getImageData(0,0,w,h),colors,rect);break;}catch(e){lastError=e;}
   }
   if(!crop)throw lastError||Error('No window frame was available. Try again.');
   const scale=Math.min(1,1600/Math.max(crop.width,crop.height)),result=document.createElement('canvas');result.width=Math.round(crop.width*scale);result.height=Math.round(crop.height*scale);
   const ctx=result.getContext('2d',{willReadFrequently:true});ctx.drawImage(canvas,crop.x,crop.y,crop.width,crop.height,0,0,result.width,result.height);
   if(ogTikTokReceiptImage.blank(ctx,result.width,result.height))throw Error('The selected window still produced a blank video. Try choosing the screen showing this receipt.');
   return result.toDataURL('image/jpeg',.9);
  }catch(e){if(e.name==='NotAllowedError')throw Error('Window capture canceled. No photo was saved.');throw e;}
  finally{clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());if(screenVideo)screenVideo.srcObject=null;markers?.remove();overlays.forEach((el,i)=>el.style.visibility=visibility[i]);}
 };
})();
