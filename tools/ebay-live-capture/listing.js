'use strict';
(() => {
 if(new URL(location.href).searchParams.has('invsto_metadata'))return;
 const event_id=location.pathname.split('/')[4];if(!/^[\w-]{6,100}$/.test(event_id||''))return;
 const box=document.createElement('details');box.id='invsto-listing-helper';
 box.style.cssText='position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#18251f;color:white;border:1px solid #98ba8b;border-radius:12px;padding:12px;width:min(340px,80vw);max-height:70vh;overflow:auto;font:14px/1.4 system-ui;box-shadow:0 3px 15px #0008';
 box.innerHTML='<summary style="cursor:pointer;font-weight:700">Invsto · Add a stock item</summary><p data-note>Send an item from Invsto Live Sales, then prepare it here.</p><p><a href="https://antdamus.github.io/Invsto/live-sales.html?capture=1&v=1.6.1" target="_blank" rel="noopener" style="color:#efd69b">Open Invsto receiver</a></p><button data-next>Prepare next item</button><div data-job hidden><strong data-title></strong><p data-details></p><p>Choose a matching template in Add listings → From template. Check its category, condition, and item specifics before creating the listing.</p><pre data-specifics style="white-space:pre-wrap;font:inherit"></pre><button data-fill>Fill selected template</button><p data-result></p><div data-confirm hidden><label>Created eBay item ID <input data-listing-id inputmode="numeric" placeholder="If automatic confirmation misses it"></label><button data-save>Record created listing</button></div><button data-release>Preparation failed — allow retry</button></div>';
 document.body.append(box);for(const b of box.querySelectorAll('button')){b.type='button';b.style.cssText='font:inherit;padding:9px 12px;margin:5px 0;border-radius:8px;cursor:pointer';}
 box.querySelector('a').href+='&listing_event='+encodeURIComponent(event_id);
 const $=s=>box.querySelector(s),note=text=>$('[data-note]').textContent=text;
 let job=null,busy=false,submitted=false,fillComplete=false,saving=false;
 const storageKey='live-listing-'+event_id;
 const autoMode=document.createElement('label');autoMode.style.cssText='display:block;margin:8px 0';autoMode.innerHTML='<input data-auto type="checkbox" checked> Prepare scans automatically';$('[data-next]').before(autoMode);
 let autoAttempted=false,autoPaused=false,checking=false;
 const announce=()=>chrome.runtime.sendMessage({type:'INVSTO_LISTING_HELLO'}).catch(()=>{});announce();setInterval(announce,5000);
 const command=async(action,extra={})=>{const result=await chrome.runtime.sendMessage({type:'INVSTO_LISTING_COMMAND',command:{event_id,action,...extra}});if(!result?.ok)throw Error(result?.error||'Invsto receiver did not respond');return result;};
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 async function until(fn,message,ms=15000){const end=Date.now()+ms;do{const found=fn();if(found)return found;await wait(150);}while(Date.now()<end);throw Error(message);}
 const button=text=>[...document.querySelectorAll('button')].find(b=>!box.contains(b)&&b.textContent.trim()===text);
 const input=name=>{const all=document.querySelectorAll(`input[name="${name}"]`);if(all.length!==1)throw Error('Open one eBay Live auction template first');return all[0];};
 function setValue(el,value){const view=el.ownerDocument.defaultView;const proto=el.tagName==='SELECT'?view.HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?view.HTMLTextAreaElement.prototype:view.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,String(value));el.dispatchEvent(new view.Event('input',{bubbles:true}));el.dispatchEvent(new view.Event('change',{bubbles:true}));el.dispatchEvent(new view.Event('blur',{bubbles:true}));}
 async function persist(){await chrome.storage.local.set({[storageKey]:job?{id:job.id,title:job.title,barcode:job.barcode,status:job.status,submitted,fillComplete}:null});}
 async function completed(listingId){
  if(!job||saving||!fillComplete)return;saving=true;
  try{await command('created',{job_id:job.id,listing_id:listingId,note:'Listing confirmed in the show'});await chrome.storage.local.remove(storageKey);note(`Created: ${job.title}. Ready for the next scan.`);job=null;submitted=false;fillComplete=false;autoAttempted=false;$('[data-job]').hidden=true;window.InvstoListingPreparing=false;}
  catch(e){note(e.message);}finally{saving=false;}
 }
 async function next(automatic=false){
  if(busy||job)return;busy=true;$('[data-next]').disabled=true;if(!automatic)note('Loading the next item and its photos…');
  try{
   const result=await command('next');if(!result.job){if(!automatic)note('Ready for scans from Invsto Live Sales.');return;}
   job=result.job;const saved=(await chrome.storage.local.get(storageKey))[storageKey];submitted=!!(saved?.id===job.id&&saved.submitted);fillComplete=job.status==='ready';
   window.InvstoListingPreparing=true;box.open=true;$('[data-job]').hidden=false;$('[data-title]').textContent=job.title;
   $('[data-details]').textContent=`${job.barcode} · $${Number(job.starting_bid).toFixed(2)} starting bid · ${job.duration_seconds} seconds · ${job.images.length} photos`;
   $('[data-specifics]').textContent=[job.category?'Stock eBay category: '+job.category:'',job.condition?'Stock condition: '+job.condition:'',job.specifics].filter(Boolean).join('\n');
   $('[data-fill]').disabled=fillComplete;$('[data-confirm]').hidden=!fillComplete;$('[data-release]').hidden=submitted||fillComplete;
   autoAttempted=false;
   note(fillComplete?'This item was already prepared. Check eBay before doing anything again.':$('[data-auto]').checked?'Choose the correct eBay template. Its item details and photos will fill automatically.':'Choose the correct eBay template, then click Fill selected template here.');
   await persist();
   if(!fillComplete&&!document.querySelector('#template-form-photos-section')){
    const tabs=[...document.querySelectorAll('[role=tab]')];let from=tabs.find(t=>t.textContent.trim()==='From template');
    if(!from){const add=button('+ Add listings')||button('Add listings');if(add&&!add.disabled)add.click();from=await until(()=>[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent.trim()==='From template'),'Open Add listings → From template on eBay');}
    from.click();
   }
  }catch(e){note(e.message);if(job)autoPaused=true;}finally{busy=false;$('[data-next]').disabled=false;}
 }
 $('[data-next]').onclick=()=>{autoPaused=false;next();};
 $('[data-fill]').onclick=async()=>{
  if(!job||busy||fillComplete||submitted)return;busy=true;$('[data-fill]').disabled=true;
  try{
   const title=input('title'),bid=input('bidPrice'),duration=input('inStreamDurationSec'),duplicate=input('duplicate');
   const section=document.querySelector('#template-form-photos-section'),file=section?.querySelector('input[type=file]');
   const frame=document.querySelector('#template-form-description-section iframe');
   const editor=await until(()=>frame?.contentDocument?.querySelector('[contenteditable=true]'),'Wait for the description editor to load, then try Fill again');
   const format=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.textContent.trim()==='eBay Live Auction'));
   if(!file||!editor||!format)throw Error('The eBay template form is not ready or its layout changed. No listing was created.');
   setValue(format,'AUCTION');setValue(duplicate,1);setValue(title,job.title);setValue(bid,Number(job.starting_bid).toFixed(2));setValue(duration,job.duration_seconds);
   const allTab=[...document.querySelectorAll('[role=tab]')].find(t=>/^All\s*\(/.test(t.textContent.trim()));
   const count=Number(allTab?.textContent.match(/\((\d+)\)/)?.[1]);
   if(Number.isFinite(count)&&count>=0){setValue(input('sequenceNumber'),count+1);const prefix=[...document.querySelectorAll('input[type=number]')].filter(i=>!i.name&&!i.id);if(prefix.length===1)setValue(prefix[0],count+1);}
   editor.textContent=job.description;editor.style.whiteSpace='pre-wrap';editor.dispatchEvent(new frame.contentWindow.InputEvent('input',{bubbles:true,inputType:'insertText'}));editor.dispatchEvent(new frame.contentWindow.Event('blur',{bubbles:true}));
   // Replace generic template photos; never leave an unrelated template image.
   let removed=0;while(section.querySelector('button[aria-label="Remove image"]')){if(++removed>25)throw Error('Could not clear template photos');section.querySelector('button[aria-label="Remove image"]').click();await wait(200);}
   const transfer=new DataTransfer();for(let i=0;i<job.images.length;i++){const bytes=Uint8Array.from(atob(job.images[i]),c=>c.charCodeAt(0));transfer.items.add(new File([bytes],`stock-${i+1}.jpg`,{type:'image/jpeg'}));}
   const upload=section.querySelector('input[type=file]');if(!upload)throw Error('The photo chooser changed. Reopen the template and try again');
   upload.files=transfer.files;upload.dispatchEvent(new Event('change',{bubbles:true}));
   note('Uploading the stock photos to eBay…');
   await until(()=>section.querySelectorAll('img[alt="Listing photo"]').length===job.images.length&&button('Create listing')&&!button('Create listing').disabled,'Photos are still uploading or eBay needs attention. Review the form before retrying.',90000);
   if(input('title').value!==job.title||Number(input('bidPrice').value)!==Number(job.starting_bid)||Number(input('inStreamDurationSec').value)!==job.duration_seconds||Number(input('duplicate').value)!==1||format.value!=='AUCTION'||!editor.textContent.includes(job.barcode))throw Error('The form did not retain all item details. Check it on eBay.');
   await command('ready',{job_id:job.id,note:'Form prepared. Review template category, condition and specifics, then click Create listing on eBay.'});
   job.status='ready';fillComplete=true;autoPaused=false;await persist();$('[data-confirm]').hidden=false;$('[data-release]').hidden=true;note('Ready. Check the template category, condition, and item specifics. Click eBay’s Create listing when correct.');
   $('[data-result]').textContent='The helper does not start the auction. The Create listing button remains on eBay.';
  }catch(e){note(e.message);autoPaused=true;$('[data-fill]').disabled=false;}finally{busy=false;}
 };
 // Only watch while this helper is open. Never choose a template or submit a listing.
 async function automatic(){
  if(checking||!box.open||!$('[data-auto]').checked||busy||autoPaused)return;checking=true;
  try{
   if(!job)await next(true);
   if(job&&!busy&&!fillComplete&&!submitted&&!autoAttempted&&document.querySelector('#template-form-photos-section')){
    autoAttempted=true;await $('[data-fill]').onclick();
   }
  }finally{checking=false;}
 }
 box.addEventListener('toggle',automatic);$('[data-auto]').onchange=()=>{autoPaused=false;automatic();};setInterval(automatic,2000);
 // Observe the user's actual submission; never click Create or Start automatically.
 document.addEventListener('click',e=>{const b=e.target.closest('button');if(job&&fillComplete&&!box.contains(b)&&b?.textContent.trim()==='Create listing'){submitted=true;$('[data-release]').hidden=true;persist();note('Waiting for the new listing to appear. If eBay reports an error, correct it in the form.');}},true);
 $('[data-save]').onclick=()=>{const id=$('[data-listing-id]').value.trim();if(!/^\d{9,20}$/.test(id)){note('Enter the numeric item ID of the listing you created.');return;}completed(id);};
 $('[data-release]').onclick=async()=>{if(!job||busy||submitted)return;try{await command('failed',{job_id:job.id,note:'Preparation stopped on the show computer before submission. Close the unfinished eBay form before retrying.'});job=null;fillComplete=false;autoPaused=true;await chrome.storage.local.remove(storageKey);$('[data-job]').hidden=true;window.InvstoListingPreparing=false;note('Preparation released. Close the unfinished form, then click Prepare next item to resume.');}catch(e){note(e.message);}};
 setInterval(()=>{
  if(!job||!submitted||!fillComplete||saving||document.querySelector('#template-form-photos-section'))return;
  const candidates=[...document.querySelectorAll('[data-testid="listing-tile"]')].filter(tile=>tile.querySelector('[data-testid="inline-edit-title"]')?.textContent.trim().replace(/^#\d+\s*-\s*/,'')===job.title);
  const ids=[...new Set(candidates.map(tile=>tile.querySelector('[data-testid^="checkbox-"]')?.getAttribute('data-testid')?.match(/^checkbox-(\d{9,20})$/)?.[1]).filter(Boolean))];
  if(ids.length===1)completed(ids[0]);
 },1500);
})();
