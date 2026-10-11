(function(root){
 'use strict';
 const watchFields=['name','brand','model','serial','department','condition','cardIncluded','materials','modificationPreset','modificationNotes','stoneSetting','braceletFit'];
 function watchDraft(previous,values,stone){
  const next={...previous,...Object.fromEntries(watchFields.map(key=>[key,String(values[key]??previous[key]??'').trim()]))};
  next.modifications=root.InventoryItemFacts.watchModifications(next);
  next.stoneSetting=root.InventoryItemFacts.watchStoneSetting(next,stone);
  if(next.brand!==previous.brand || next.model!==previous.model) delete next.referenceLookup;
  return next;
 }
 const api={watchFields,watchDraft};root.StockWorkspace=api;
 if(!root.document)return;
 let sections=[],nav,returnFocus;
 function field(id){
  const input=document.getElementById(id);if(!input)return null;
  const label=document.querySelector(`label[for="${id}"]`),wrap=document.createElement('div');wrap.className='stock-edit-field';
  if(input.tagName==='TEXTAREA'||id==='edit-title'||id==='edit-watch-modificationPreset')wrap.classList.add('is-wide');
  const helper=input.nextElementSibling?.matches('.field-helper')?input.nextElementSibling:null;
  if(label)wrap.append(label);wrap.append(input);if(helper)wrap.append(helper);return wrap;
 }
 function setup(){
  const form=document.getElementById('edit-item-form');if(!form)return;
  const body=form.querySelector('.form-content-wrapper');
  nav=document.createElement('nav');nav.className='stock-edit-nav';nav.setAttribute('aria-label','Item editor sections');form.before(nav);
  function section(id,title,help,fields=[],existing){
   const el=existing||document.createElement('section');el.id=id;el.classList.add('stock-edit-section');
   if(!existing){const h=document.createElement('h3');h.textContent=title;el.append(h);}
   if(help){const p=document.createElement('p');p.className='stock-edit-help';p.textContent=help;el.append(p);}
   const grid=document.createElement('div');grid.className='stock-edit-grid';fields.map(field).filter(Boolean).forEach(f=>grid.append(f));el.append(grid);body.append(el);
   const button=document.createElement('button');button.type='button';button.textContent=title;button.addEventListener('click',()=>{el.scrollIntoView({behavior:'smooth',block:'start'});el.querySelector('input,select,textarea,button')?.focus({preventScroll:true});});nav.append(button);
   sections.push({el,button});return el;
  }
  section('stock-edit-identity','Piece details','The name and description are client-facing. Keep serial numbers in the internal watch field.',['edit-title','edit-description','edit-weight','edit-stone-type','edit-length']);
  section('edit-watch-details','Watch','Record only confirmed specifications and modifications.',watchFields.map(key=>'edit-watch-'+key),document.getElementById('edit-watch-details'));
  section('stock-edit-pricing','Pricing','Retail, minimum sale and cost remain separate. Pending pricing is completed in the pricing queue.',['edit-cost','edit-sale-price','edit-minimum-sale-price','edit-price-per-weight']);
  const photos=document.querySelector('#editItemModal .photos-section-wrapper');photos.id='stock-edit-photos';photos.classList.add('stock-edit-section');body.append(photos);
  const photosButton=document.createElement('button');photosButton.type='button';photosButton.textContent='Photos';photosButton.addEventListener('click',()=>photos.scrollIntoView({behavior:'smooth',block:'start'}));nav.append(photosButton);sections.push({el:photos,button:photosButton});
  const labels=section('stock-edit-labels','Labels & stock','Your barcode stays unchanged. Stock quantities are managed from the piece’s Stock & location actions.',['edit-barcode','edit-qr-type','edit-qr','edit-stock-batch']);
  labels.append(document.getElementById('generate-edit-dymo-label'));
  const coin=document.getElementById('edit-coin-details');body.append(coin);
  const certification=document.querySelector('.stock-edit-certification');body.append(certification);
  const footer=document.createElement('div');footer.className='stock-edit-actions';
  const cancel=document.createElement('button');cancel.type='button';cancel.className='stock-secondary-btn';cancel.textContent='Cancel';cancel.addEventListener('click',()=>document.getElementById('closeEditModal').click());
  footer.append(cancel,form.querySelector('.save-edit-btn'));form.append(footer);
  document.getElementById('editItemModal').addEventListener('keydown',event=>{
   if(event.key==='Escape'){event.preventDefault();document.getElementById('closeEditModal').click();return;}
   if(event.key!=='Tab')return;
   const nodes=[...event.currentTarget.querySelectorAll('button,input,textarea,select,a[href]')].filter(el=>!el.disabled&&el.getClientRects().length);
   const first=nodes[0],last=nodes.at(-1);
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  });
  document.getElementById('closeEditModal').addEventListener('click',()=>returnFocus?.isConnected&&returnFocus.focus({preventScroll:true}));
 }
 api.refreshEdit=(item,canSensitive)=>{
  document.getElementById('stock-edit-pricing').hidden=!canSensitive;
  document.getElementById('stock-edit-mode-note').textContent=`${item.title || 'Untitled piece'} · ${item.barcode || 'No barcode'}`;
  for(const {el,button} of sections)button.hidden=el.hidden;
  returnFocus=document.activeElement;
 };
 api.focusEdit=()=>{document.getElementById('edit-item-form').scrollTop=0;document.getElementById('edit-title').focus({preventScroll:true});};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup,{once:true});else setup();
})(typeof window==='undefined'?globalThis:window);
