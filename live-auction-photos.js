(() => {
  'use strict';
  let show=null,attempts=[],counts=new Map(),readKey='',readAt=0,reading=null,revision=0,selected=null,dialog;
  const $=id=>document.getElementById(id);
  function badges(){
    document.querySelectorAll('[data-auction-photos]').forEach(button=>{
      const sale=attempts.find(a=>a.id===button.dataset.auctionPhotos),count=sale?.lot_id?counts.get(sale.lot_id):0;
      button.querySelector('[data-photo-count]').textContent=count==null?'':String(count);
      button.classList.toggle('has-photos',count>0);
      button.setAttribute('aria-label',`Photos for ${sale?.listing_title||'bag'}${count==null?'':` · ${count} saved`}`);
    });
  }
  async function updateCounts(force=false){
    if(document.visibilityState==='hidden'&&!force)return;
    const ids=[...new Set(attempts.map(a=>a.lot_id).filter(Boolean))].sort(),key=JSON.stringify([show,ids]);
    if(reading||(!force&&readKey===key&&Date.now()-readAt<10000))return;
    const version=revision;readKey=key;readAt=Date.now();
    const task=(async()=>{
      try{
        const next=new Map(ids.map(id=>[id,0]));
        for(let i=0;i<ids.length;i+=100){
          for(let offset=0;;offset+=1000){
            const {data,error}=await window.supabase.from('live_sale_bag_photos').select('lot_id').in('lot_id',ids.slice(i,i+100)).order('id').range(offset,offset+999);
            if(error)throw error;
            if(version!==revision)return;
            for(const photo of data||[])next.set(photo.lot_id,(next.get(photo.lot_id)||0)+1);
            if((data?.length||0)<1000)break;
          }
        }
        if(version===revision){counts=next;badges();}
      }catch{ /* Leave unknown counts unlabeled; the gallery has its own retry. */ }
    })();
    reading=task;try{await task;}finally{if(reading===task)reading=null;}
  }
  function ensureDialog(){
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.id='live-auction-photos';dialog.setAttribute('aria-labelledby','auction-photos-title');
    dialog.innerHTML='<header class="auction-photos-head"><div><span class="eyebrow">Bag photos</span><h2 id="auction-photos-title"></h2><p id="auction-photos-buyer"></p></div><button type="button" id="auction-photos-close" aria-label="Close bag photos">✕</button></header><p class="auction-photos-hint">Every camera click adds a photo to this bag. Tap any photo to enlarge it.</p><section id="auction-photos-gallery" aria-label="Saved live photos"></section><section id="auction-photos-preview" hidden><div class="auction-photos-navigation"><button type="button" id="auction-photos-back">All photos</button><button type="button" id="auction-photos-previous" aria-label="Previous photo">←</button><button type="button" id="auction-photos-next" aria-label="Next photo">→</button></div><img id="auction-photos-image" alt=""><p id="auction-photos-caption"></p></section><footer><span>Photos update automatically while this window is open.</span><button type="button" id="auction-photos-refresh">Refresh photos</button></footer>';
    document.body.append(dialog);
    $('auction-photos-close').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{selected=null;$('auction-photos-image').removeAttribute('src');});
    const back=()=>{$('auction-photos-preview').hidden=true;$('auction-photos-gallery').hidden=false;$('auction-photos-gallery').querySelector('button')?.focus();};
    $('auction-photos-back').onclick=back;
    dialog.addEventListener('cancel',e=>{if(!$('auction-photos-preview').hidden){e.preventDefault();back();}});
    const step=direction=>{const buttons=[...$('auction-photos-gallery').querySelectorAll('button[aria-label]')];const at=Number($('auction-photos-preview').dataset.index||0);buttons[at+direction]?.click();};
    $('auction-photos-previous').onclick=()=>step(-1);$('auction-photos-next').onclick=()=>step(1);
    dialog.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&!$('auction-photos-preview').hidden){e.preventDefault();e.stopPropagation();back();return;}
      if(!$('auction-photos-preview').hidden&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();step(e.key==='ArrowLeft'?-1:1);}
    });
    $('auction-photos-refresh').onclick=()=>{readAt=0;void updateCounts(true);void refreshGallery(true);};
  }
  async function refreshGallery(force=false){
    if(!dialog?.open||!selected||document.visibilityState==='hidden')return;
    const sale=attempts.find(a=>a.id===selected);
    if(!sale){dialog.close();return;}
    $('auction-photos-title').textContent=sale.listing_title||'Auction bag';
    $('auction-photos-buyer').textContent=`${sale.buyer||'No winner yet'} · ${sale.seller_name||'Seller not assigned'}`;
    const host=$('auction-photos-gallery');
    if(!sale.lot_id){host.replaceChildren();const empty=document.createElement('p');empty.textContent='No live photos saved yet. Once payment is confirmed, select this bag in the eBay console and tap the camera beside Print label.';host.append(empty);return;}
    await window.liveBagPhotos.load(host,sale.lot_id,(url,title)=>{
      const buttons=[...host.querySelectorAll('button[aria-label]')],at=buttons.findIndex(b=>b.querySelector('img')?.src===url);
      $('auction-photos-preview').dataset.index=String(Math.max(0,at));
      $('auction-photos-image').src=url;$('auction-photos-image').alt=sale.listing_title;
      $('auction-photos-caption').textContent=title;
      $('auction-photos-previous').disabled=at<=0;$('auction-photos-next').disabled=at>=buttons.length-1;
      host.hidden=true;$('auction-photos-preview').hidden=false;$('auction-photos-back').focus();
    },{force,showEmpty:true});
    if(!$('auction-photos-preview').hidden)host.hidden=true;
  }
  window.liveAuctionPhotos={
    sync(rows,sessionId){
      if(show!==sessionId){show=sessionId;revision++;counts=new Map();readKey='';readAt=0;dialog?.close();}
      attempts=rows;badges();void updateCounts();
    },
    open(sale){
      ensureDialog();selected=sale.id;
      const host=document.createElement('section');host.id='auction-photos-gallery';host.setAttribute('aria-label','Saved live photos');$('auction-photos-gallery').replaceWith(host);
      $('auction-photos-preview').hidden=true;
      const loading=document.createElement('p');loading.textContent='Loading bag photos…';$('auction-photos-gallery').append(loading);
      dialog.showModal();void refreshGallery(true);
    }
  };
  window.addEventListener('live-bag-photo-saved',()=>{readAt=0;void updateCounts(true);void refreshGallery(true);});
  setInterval(()=>{if(dialog?.open&&document.visibilityState==='visible')void refreshGallery(true);},5000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){readAt=0;void refreshGallery(true);}});
})();
