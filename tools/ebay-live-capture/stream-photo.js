'use strict';
(() => {
  // This script runs only inside eBay's media renderer. Drawing the video itself
  // excludes the player UI, chat, and every other part of the dashboard.
  const video=()=>[...document.querySelectorAll('video')]
    .filter(v=>v.readyState>=2&&v.videoWidth>=160&&v.videoHeight>=160&&!v.paused&&!v.ended&&v.getClientRects().length)
    .sort((a,b)=>b.videoWidth*b.videoHeight-a.videoWidth*a.videoHeight)[0];
  const announce=()=>{if(video())chrome.runtime.sendMessage({type:'INVSTO_STREAM_FRAME'}).catch(()=>{});};
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id||message?.type!=='INVSTO_CAPTURE_STREAM_PHOTO')return;
    try {
      const v=video();if(!v)throw Error('The live video is not playing. Start the preview, then try the camera again.');
      const scale=Math.min(1,1600/Math.max(v.videoWidth,v.videoHeight));
      const canvas=document.createElement('canvas');canvas.width=Math.round(v.videoWidth*scale);canvas.height=Math.round(v.videoHeight*scale);
      canvas.getContext('2d').drawImage(v,0,0,canvas.width,canvas.height);
      const dataUrl=canvas.toDataURL('image/jpeg',.9);
      if(dataUrl.length>4000000)throw Error('This frame is too large. Try the camera again.');
      reply({ok:true,image:{dataUrl,width:canvas.width,height:canvas.height,capturedAt:new Date().toISOString()}});
    }catch(error){reply({ok:false,error:error.name==='SecurityError'?'This player cannot share a clean video frame. Refresh the eBay preview and try again.':error.message});}
  });
  announce();setInterval(announce,10000);document.addEventListener('playing',announce,true);
})();
