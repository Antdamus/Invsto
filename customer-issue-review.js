(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let db,rows=[],loaded=false,busy=false,notify=()=>{},redraw=()=>{};
 const checked=r=>{if(r.error)throw r.error;return r.data;};
 const entry=id=>rows.find(r=>(r.case_ids||[r.case_id]).includes(id));
 function button(c){const r=entry(c.id);return `<div class="issue-review-mark"><button class="secondary-btn ${r?'is-marked':''}" data-ebay-review-mark="${esc(c.id)}" ${!loaded||busy?'disabled':''}>${r?'✓ In eBay review':'＋ Add to eBay review'}</button>${r?`<a href="customer-issue-review-report.html#review-${esc(r.case_id)}">Position &amp; report ↗</a>`:''}</div>`;}
 async function load(){try{rows=checked(await db.rpc('list_customer_issue_ebay_reviews'))||[];loaded=true;}catch{loaded=false;}const count=document.getElementById('issue-review-count');if(count)count.textContent=loaded?rows.length:'—';}
 async function init({client,feedback,onChange}){
  db=client;notify=feedback;redraw=onChange;await load();
  document.getElementById('issues-workspace').addEventListener('click',async event=>{
   const b=event.target.closest('[data-ebay-review-mark]');if(!b||busy)return;
   const id=b.dataset.ebayReviewMark,r=entry(id);if(r){location.href=`customer-issue-review-report.html#review-${encodeURIComponent(r.case_id)}`;return;}
   busy=true;b.disabled=true;
   try{checked(await db.rpc('save_customer_issue_ebay_review',{_case_id:id,_action:'mark'}));await load();notify('Added to eBay review. Open the review packet to write our position and generate the PDF.');}
   catch(e){notify(e.message||'Could not add this issue. Please retry.',true);}
   finally{busy=false;redraw();}
  });
 }
 root.OGIssueReview={init,load,button};
})(globalThis);
