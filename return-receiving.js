/* Package lookup is read-only. Only Save return can receive or restock stock. */
(function(root){
 'use strict';
 const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let api,busy=false,matchVersion=0;
 function open(){
  if(busy||api.ctx.state.busy)return;
  $('return-package-dialog').showModal();$('return-package-results').innerHTML='';$('return-package-code').value='';$('return-package-code').focus();
 }
 async function select(match){
  if(busy)return;busy=true;const target=$('return-package-results');
  try{
   if(match.case_id){await api.openCase(match.case_id);$('return-package-dialog').close();api.feedback('Package found. Compare the saved item photos, then receive or inspect the return.');}
   else{
    const result=await api.db.from('ebay_order_lines').select(api.ctx.lineSelect).eq('order_id',match.order_id).eq('line_status','fulfilled');if(result.error)throw result.error;
    const lines=(result.data||[]).map(api.ctx.normalizeLine);if(!lines.length)throw Error('No fulfilled items are available. Review this order in Order History.');
    api.ctx.mergeLines(lines);api.ctx.state.returnTaskOrderEvents=await api.ctx.loadOrderEvents(lines.map(l=>l.id));
    $('return-package-dialog').close();api.ctx.openIntake(lines.map(l=>l.id));
   }
  }catch(e){target.textContent=e.message||'Could not open this return. Please retry.';}finally{busy=false;}
 }
 async function find(event){
  event?.preventDefault();if(busy)return;const stamp=++matchVersion;busy=true;
  const target=$('return-package-results');target.textContent='Finding the package…';$('find-return-package').disabled=true;
  try{
   const result=await api.db.rpc('lookup_customer_return_package',{_code:$('return-package-code').value.trim()});if(result.error)throw result.error;if(stamp!==matchVersion)return;
   const matches=result.data?.matches||[];
   if(result.data?.too_many){target.textContent='This label covers many returns. Enter the exact order number or eBay return ID.';return;}
   if(!matches.length){target.innerHTML='<h3>No saved label matches</h3><p>Enter the original eBay order number or return ID above. If the order is not known, close this window and search by buyer. Nothing has been received or restocked.</p>';return;}
   if(matches.length===1&&matches[0].case_id){busy=false;await select(matches[0]);return;}
   target.innerHTML=`<h3>${matches.length===1?'Verify the original order':'Choose the correct return'}</h3><p>Open a match to compare the saved item photos before receiving anything.</p>`+matches.map((m,i)=>`<button class="return-match" type="button" data-return-match="${i}"><strong>${esc(m.buyer||'Buyer not reported')}</strong><span>Order ${esc(m.order_number||'not linked')}</span><span>${esc(m.item_title||'Open to verify order items')}</span><small>${m.case_reference?'Return '+esc(m.case_reference)+' · ':''}${esc(String(m.status).replaceAll('_',' '))}${m.opened_at?' · '+esc(new Date(m.opened_at).toLocaleDateString()):''}</small><b>${m.case_id?'Open return →':'Verify items & receive →'}</b></button>`).join('');
   target.querySelectorAll('[data-return-match]').forEach(b=>b.onclick=()=>select(matches[Number(b.dataset.returnMatch)]));
  }catch(e){target.textContent=e.message||'Package lookup failed. Please retry.';}finally{busy=false;$('find-return-package').disabled=false;}
 }
 function init(context){
  api=context;if(!$('return-package-dialog'))return;
  $('scan-return-package').onclick=open;$('return-package-form').onsubmit=find;
  $('close-return-package').onclick=()=>$('return-package-dialog').close();
  $('return-package-dialog').addEventListener('close',()=>{++matchVersion;});
 }
 root.OGReturnReceiving={init,open};
})(globalThis);
