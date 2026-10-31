(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WhatnotOrdersModel=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function url(value){try{const u=new URL(value);return u.protocol==='https:'&&['www.whatnot.com','whatnot.com'].includes(u.hostname)&&!u.username&&!u.password?u.href:'';}catch{return '';}}
 const money=(amount,currency='USD')=>new Intl.NumberFormat('en-US',{style:'currency',currency}).format(Number(amount||0));
 const time=value=>value?new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'America/New_York'}).format(new Date(value))+' ET':'Not provided';
 function calendar(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
 function urgency(value,now=new Date()){
  if(!value)return {kind:'unknown',text:'Due date not provided'};
  const n=Math.round((Date.parse(value+'T00:00:00Z')-Date.parse(calendar(now)+'T00:00:00Z'))/86400000);
  return n<0?{kind:'overdue',text:`Overdue ${-n} day${n===-1?'':'s'} · due ${value}`}:n===0?{kind:'today',text:`Due today · ${value}`}:n===1?{kind:'tomorrow',text:`Due tomorrow · ${value}`}:{kind:'future',text:`Due ${value}`};
 }
 function tracking(number,carrier=''){
  const code=String(number||'').replace(/\s/g,'');if(!code)return '';
  const enc=encodeURIComponent(code),name=carrier.toLowerCase();
  if(name.includes('usps')||/^9\d{19,25}$/.test(code))return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${enc}`;
  if(name.includes('ups')||/^1Z/i.test(code))return `https://www.ups.com/track?tracknum=${enc}`;
  if(name.includes('fedex'))return `https://www.fedex.com/fedextrack/?trknbr=${enc}`;
  if(name.includes('dhl'))return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${enc}`;
  return '';
 }
 const snapshot=lines=>lines.map(l=>({id:l.id,revision:l.revision}));
 const ready=l=>l.work_state==='pending'&&l.order_record.status==='pending_fulfillment'&&!l.item_missing&&!l.cgl_pending&&!l.holds?.length&&!l.replacement_shipment_id&&Boolean(l.tracking_number);
 function receipt(l){const direct=url(l.receipt_url);if(direct)return direct;const order=url(l.order_record?.url);return order?order+'#invsto-receipt='+encodeURIComponent(l.id)+'&order='+encodeURIComponent(l.order_id):'';}
 return {escape,url,money,time,calendar,urgency,tracking,snapshot,ready,receipt};
});
