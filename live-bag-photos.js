(() => {
  'use strict';
  const hosts=new WeakMap();
  const signedUrls=new Map();
  async function photoUrl(path){
    const cached=signedUrls.get(path);if(cached&&cached.until>Date.now())return cached.url;
    const {data,error}=await window.supabase.storage.from('photos').createSignedUrl(path,3600);
    if(error||!data?.signedUrl)throw error||Error('Photo unavailable');
    if(signedUrls.size>200)signedUrls.clear();
    signedUrls.set(path,{url:data.signedUrl,until:Date.now()+3000000});return data.signedUrl;
  }
  let styled=false;
  function styles(){
    if(styled)return;styled=true;
    const style=document.createElement('style');style.textContent='.live-bag-photos{margin:14px 0;padding:14px;border:1px solid #88764e55;border-radius:14px}.live-bag-photos[hidden]{display:none}.live-bag-photos h3{font-size:15px;margin:0 0 10px}.live-bag-photo-grid{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px}.live-bag-photo-grid button{flex:0 0 94px;padding:0;border:1px solid #88764e66;border-radius:10px;overflow:hidden;background:transparent;color:inherit;cursor:pointer}.live-bag-photo-grid img{display:block;width:94px;height:120px;object-fit:cover}.live-bag-photo-grid span{display:block;padding:5px;font-size:11px}.live-bag-photos p{font-size:13px;margin:0}';document.head.append(style);
  }
  async function load(container,lotId,openPhoto,{force=false,showEmpty=false}={}){
    if(!container)return;
    const previous=hosts.get(container);
    if(!force&&previous&&previous.lotId===lotId&&(previous.loading||Date.now()-previous.at<15000))return;
    if(previous?.loading&&previous.lotId===lotId)return;
    const same=!!previous&&previous.lotId===lotId;
    const state={lotId,at:Date.now(),loading:true,signature:same?previous?.signature:null};hosts.set(container,state);
    if(!same){container.replaceChildren();container.hidden=true;}
    if(!lotId){state.loading=false;return;}
    styles();container.classList.add('live-bag-photos');
    const current=()=>hosts.get(container)===state&&container.isConnected;
    try{
      const {data,error}=await window.supabase.from('live_sale_bag_photos').select('id,photo_path,captured_at,width,height').eq('lot_id',lotId).order('created_at');
      if(error)throw error;if(!current())return;
      const signature=JSON.stringify(data||[]);
      if(state.signature===signature&&!previous?.failed&&Date.now()-(previous?.renderedAt||0)<3000000){state.renderedAt=previous.renderedAt;return;}
      state.signature=signature;state.renderedAt=Date.now();container.replaceChildren();
      if(!data?.length){container.hidden=!showEmpty;if(showEmpty){const empty=document.createElement('p');empty.className='live-bag-photo-empty';empty.textContent='No live photos saved yet. In the eBay console, select this paid bag and tap the camera beside Print label. Each click adds another photo.';container.append(empty);}return;}
      const heading=document.createElement('h3');heading.textContent=`Live photos · ${data.length}`;
      const grid=document.createElement('div');grid.className='live-bag-photo-grid';container.append(heading,grid);container.hidden=false;
      await Promise.all(data.map(async(photo,index)=>{
        const button=document.createElement('button');button.type='button';button.disabled=true;button.setAttribute('aria-label',`View live photo ${index+1}`);button.textContent='Loading…';grid.append(button);
        let url;try{url=await photoUrl(photo.photo_path);}catch{state.failed=true;button.textContent='Photo unavailable';button.disabled=false;button.onclick=()=>load(container,lotId,openPhoto,{force:true,showEmpty});return;}
        if(!current())return;
        const img=new Image();img.src=url;img.alt=`Livestream photo ${index+1}`;img.loading='lazy';
        const time=document.createElement('span');time.textContent=new Date(photo.captured_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
        button.replaceChildren(img,time);button.disabled=false;button.onclick=()=>openPhoto(url,`Live photo ${index+1} of ${data.length} · ${new Date(photo.captured_at).toLocaleString()}`);
      }));
    }catch{
      if(!current())return;state.failed=true;container.replaceChildren();container.hidden=false;
      const text=document.createElement('p');text.textContent='Live photos could not load. ';
      const retry=document.createElement('button');retry.type='button';retry.textContent='Try again';retry.onclick=()=>load(container,lotId,openPhoto,{force:true,showEmpty});text.append(retry);container.append(text);
    }finally{state.loading=false;}
  }
  window.liveBagPhotos={load};
})();
