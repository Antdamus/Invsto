(() => {
  'use strict';
  const hosts=new WeakMap();
  let styled=false;
  function styles(){
    if(styled)return;styled=true;
    const style=document.createElement('style');style.textContent='.live-bag-photos{margin:14px 0;padding:14px;border:1px solid #88764e55;border-radius:14px}.live-bag-photos[hidden]{display:none}.live-bag-photos h3{font-size:15px;margin:0 0 10px}.live-bag-photo-grid{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px}.live-bag-photo-grid button{flex:0 0 94px;padding:0;border:1px solid #88764e66;border-radius:10px;overflow:hidden;background:transparent;color:inherit;cursor:pointer}.live-bag-photo-grid img{display:block;width:94px;height:120px;object-fit:cover}.live-bag-photo-grid span{display:block;padding:5px;font-size:11px}.live-bag-photos p{font-size:13px;margin:0}';document.head.append(style);
  }
  async function load(container,lotId,openPhoto,{force=false}={}){
    if(!container)return;
    const previous=hosts.get(container);
    if(!force&&previous&&previous.lotId===lotId&&(previous.loading||Date.now()-previous.at<15000))return;
    const state={lotId,at:Date.now(),loading:true};hosts.set(container,state);
    container.replaceChildren();container.hidden=true;
    if(!lotId){state.loading=false;return;}
    styles();container.classList.add('live-bag-photos');
    const current=()=>hosts.get(container)===state&&container.isConnected;
    try{
      const {data,error}=await window.supabase.from('live_sale_bag_photos').select('id,photo_path,captured_at,width,height').eq('lot_id',lotId).order('created_at');
      if(error)throw error;if(!current()||!data?.length)return;
      const heading=document.createElement('h3');heading.textContent=`Live photos · ${data.length}`;
      const grid=document.createElement('div');grid.className='live-bag-photo-grid';container.append(heading,grid);container.hidden=false;
      await Promise.all(data.map(async(photo,index)=>{
        const button=document.createElement('button');button.type='button';button.disabled=true;button.setAttribute('aria-label',`View live photo ${index+1}`);button.textContent='Loading…';grid.append(button);
        const {data:signed,error}=await window.supabase.storage.from('photos').createSignedUrl(photo.photo_path,3600);
        if(!current())return;
        if(error||!signed?.signedUrl){button.textContent='Photo unavailable';return;}
        const img=new Image();img.src=signed.signedUrl;img.alt=`Livestream photo ${index+1}`;img.loading='lazy';
        const time=document.createElement('span');time.textContent=new Date(photo.captured_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
        button.replaceChildren(img,time);button.disabled=false;button.onclick=()=>openPhoto(signed.signedUrl,`Live photo · ${new Date(photo.captured_at).toLocaleString()}`);
      }));
    }catch{
      if(!current())return;container.hidden=false;
      const text=document.createElement('p');text.textContent='Live photos could not load. ';
      const retry=document.createElement('button');retry.type='button';retry.textContent='Try again';retry.onclick=()=>load(container,lotId,openPhoto,{force:true});text.append(retry);container.append(text);
    }finally{state.loading=false;}
  }
  window.liveBagPhotos={load};
})();
