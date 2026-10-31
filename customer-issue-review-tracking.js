(function(root){
 'use strict';
 const list=v=>Array.isArray(v)?v:[],code=v=>String(v||'').replace(/[\s-]+/g,'').toUpperCase(),nice=v=>String(v||'').replace(/_/g,' ').toLowerCase().replace(/^./,c=>c.toUpperCase());
 const scalar=v=>typeof v==='string'||typeof v==='number'?String(v):'';
 function numbers(m={}){m=m||{};return [...new Set([m.trackingNumber,m.shippingBarcodeNumber,...list(m.trackingNumbers),...list(m.shippingBarcodeNumbers),...list(m.labelRows).flatMap(numbers)].map(code).filter(Boolean))];}
 function carrierUrl(carrier,tracking){const c=String(carrier||'').toLowerCase(),t=encodeURIComponent(tracking);if(c.includes('usps'))return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;if(c.includes('fedex'))return `https://www.fedex.com/fedextrack/?trknbr=${t}`;if(c.includes('ups'))return `https://www.ups.com/track?tracknum=${t}`;if(c.includes('dhl'))return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}`;return `https://www.17track.net/en/track?nums=${t}`;}
 // Copied carrier scans have local wall-clock times, often without a zone.
 // Keep that provenance rather than interpreting them in the reviewer's zone.
 function scanMilestones(entry){
  const rows=String(entry.history?.history_text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean),found={shipped:[],delivered:[]};
  const stamp=/^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM))?(?:\s+(EST|EDT|CST|CDT|MST|MDT|PST|PDT|UTC|GMT))?$/i;
  for(let n=0;n<rows.length;n++){
   const event=rows[n],kind=/^(?:(?:Accepted, )?USPS in possession of item|Accepted at USPS (?:Origin Facility|Regional Origin Facility)|Accepted at USPS Facility|Picked up|Accepted at (?:UPS|FedEx) Origin Facility)$/i.test(event)?'shipped':/^Delivered(?:[ ,.-].*)?$/i.test(event)&&!/(?:return|sender|shipper|attempt|not delivered|expected|estimated)/i.test(event)?'delivered':null;
   if(!kind)continue;
   let location='';
   for(let p=n+1;p<=n+2&&p<rows.length;p++){
    const match=rows[p].match(stamp);
    if(match){
     const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[1].slice(0,3).toLowerCase());
     const day=Number(match[2]),year=Number(match[3]),hour=match[4]?Number(match[4]):0,minute=Number(match[5]||0),utc=Date.UTC(year,month,day,(hour%12)+(match[6]?.toUpperCase()==='PM'?12:0),minute);
     if(new Date(utc).getUTCDate()!==day||hour>12||(match[4]&&hour<1)||minute>59)break;
     const zone=match[7]?.toUpperCase(),weekday=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long'}).format(new Date(utc));
     found[kind].push({value:`${weekday}, ${rows[p]}`,source:`${entry.history?.carrier||entry.carrier||'Carrier'} ${kind==='shipped'?'acceptance':'delivery'} scan · ${zone?'carrier time '+zone:'carrier local time (zone not supplied)'}`,event,location,sort:utc});break;
    }
    // Only a location can intervene between a scan label and its timestamp.
    if(p!==n+1||!/[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.test(rows[p]))break;
    location=rows[p];
   }
  }
  return {shipped:found.shipped.sort((a,b)=>a.sort-b.sort)[0]||null,delivered:found.delivered.sort((a,b)=>b.sort-a.sort)[0]||null};
 }
 function milestones(entry){
  const scans=scanMilestones(entry);
  if(!scans.shipped){const recorded=entry.events.filter(e=>e.title==='Shipment recorded by eBay'&&Number.isFinite(Date.parse(e.at))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))[0];if(recorded)scans.shipped={value:root.OGIssueReviewModel.date(recorded.at),source:'Shipment recorded by eBay; carrier acceptance scan not saved'};}
  return scans;
 }
 function build(members,items,baseUrl,histories=[]){
  const entries=new Map(),lineIds=new Set(items.map(i=>i.id));
  const events=(entry,at,title,source,body='')=>{if(at)entry.events.push({at,title,source,body});};
  function add(value,options={}){const tracking=code(value);if(!tracking)return null;const direction=options.direction||'outbound',key=`${direction}:${tracking}`;
   let entry=entries.get(key);if(!entry){entry={code:tracking,direction,carrier:'',status:'Carrier status not saved',statusSource:'',statusAt:'',scopes:[],sources:[],events:[],history:null,...options};entries.set(key,entry);}
   if(options.carrier)entry.carrier=options.carrier;if(options.scope&&!entry.scopes.includes(options.scope))entry.scopes.push(options.scope);if(options.source&&!entry.sources.includes(options.source))entry.sources.push(options.source);
   if(options.status&&(!entry.statusAt||Date.parse(options.statusAt)>=Date.parse(entry.statusAt))){entry.status=nice(options.status);entry.statusSource=options.source;entry.statusAt=options.statusAt||'';}
   return entry;
  }
  for(const m of members){
   const lines=list(m.lines),orders=list(m.orders),labels=list(m.label_events);
   for(const l of lines){const scope=`Item ${l.item_number||l.id} · Order ${orders.find(o=>o.id===l.order_id)?.order_number||m.case.order_number}`;
    for(const shipment of list(l.raw_payload?.shipping_reconciliation?.shipments)){const e=add(shipment.trackingNumber,{carrier:shipment.carrier,scope,source:'eBay shipment matched to this order line'});if(e)events(e,shipment.shippedAt,'Shipment recorded by eBay','eBay fulfillment',scope);}
    for(const n of numbers(l.label_metadata||l.raw_payload?.label_metadata))add(n,{scope,source:'Order-line label metadata'});
    if(l.raw_payload?.tracking_number)add(l.raw_payload.tracking_number,{scope,source:'Order-line tracking'});
   }
   for(const e of labels){const scoped=list(e.order_line_ids);if(scoped.length&&!scoped.some(id=>lineIds.has(id)))continue;
    const scope=scoped.length?'Label attached to the selected item line(s)':'Order-level label; exact item coverage not recorded';
    for(const n of numbers(e.label_metadata)){const entry=add(n,{carrier:e.label_metadata?.carrier,scope,source:'Order History shipping label'});if(entry)events(entry,e.created_at,`Shipping label ${nice(e.action).toLowerCase()}`,'Order History',e.signed_by_email?`Recorded by ${e.signed_by_email}`:'');}
   }
   for(const o of orders){const metadata=o.label_metadata||{},matching=labels.filter(e=>e.label_file_path&&e.label_file_path===o.label_file_path),explicit=list(metadata.orderLineIds||metadata.order_line_ids);
    const applies=explicit.length?explicit.some(id=>lineIds.has(id)):!matching.length||matching.some(e=>!list(e.order_line_ids).length||e.order_line_ids.some(id=>lineIds.has(id)));
    const count=m.order_line_count??list(o.raw_payload?.order?.lineItems).length;
    const scope=count===1?`Only item in order ${o.order_number}`:`Order ${o.order_number} · order-level tracking; confirm item coverage`;
    if(applies)for(const n of numbers(metadata)){const entry=add(n,{carrier:metadata.carrier,scope,source:'Saved shipping label'});if(entry)events(entry,metadata.capturedAt||o.label_uploaded_at,'Shipping label captured','Saved shipping label');}
    for(const n of [o.tracking_number,o.raw_payload?.tracking_number,o.raw_payload?.first_row?.['Tracking Number']].filter(Boolean))add(n,{carrier:metadata.carrier,scope,source:'Saved order tracking'});
   }
   const c=m.case||{},detail=c.raw_payload?.ebayDetail||{};
   // These provider fields describe the outbound shipment for this specific case.
   const history=c.source_lane==='inquiry'&&String(detail.inquiryId)===String(c.ebay_return_id)?detail.inquiryHistoryDetails:c.source_lane==='case'&&String(detail.caseId)===String(c.ebay_return_id)?detail.caseHistoryDetails:null;
   const tracking=history?.shipmentTrackingDetails;
   for(const s of Array.isArray(tracking)?tracking:tracking?[tracking]:[]){const e=add(s.trackingNumber,{carrier:scalar(s.carrierName||s.carrier),scope:`Shipment referenced by eBay case ${c.ebay_return_id}`,source:'eBay case tracking',status:scalar(s.currentStatus),statusAt:c.synced_at});if(e)events(e,c.synced_at,`eBay tracking status: ${nice(s.currentStatus)||'Not recorded'}`,'eBay case sync','Status observed at this time; this is not the delivery scan time.');}
   if(c.return_tracking_number)add(c.return_tracking_number,{direction:'return',carrier:scalar(detail.returnShipmentInfo?.carrier),scope:`Return shipment for case ${c.ebay_return_id}`,source:'Return tracking saved in Invsto'});
   for(const p of list(m.packages))if(p.tracking_code){const e=add(p.tracking_code,{scope:'Package linked to this order; confirm item coverage',source:'Packaging record'});if(e)events(e,p.updated_at,`Packaging record: ${nice(p.status)}`,'Invsto packaging','This is an internal package status.');}
  }
  for(const entry of entries.values()){
   entry.url=carrierUrl(entry.carrier,entry.code);entry.label=entry.direction==='return'?'Return to us':'Outbound shipment';
   const u=new URL('ebay-order-history.html',baseUrl);u.searchParams.set('orderHistorySearch',entry.code);u.searchParams.set('historyAllDates','true');entry.historyUrl=u.href;
   entry.events=[...new Map(entry.events.map(e=>[JSON.stringify([e.at,e.title,e.source,e.body]),e])).values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
   entry.history=histories.find(h=>code(h.tracking_number)===entry.code&&h.direction===entry.direction)||null;
  }
  return [...entries.values()];
 }
 const api={build,numbers,carrierUrl,scanMilestones,milestones};root.OGIssueReviewTracking=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
