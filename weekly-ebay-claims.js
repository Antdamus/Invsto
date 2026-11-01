(function(root){
 'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const usd=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}),money=n=>(n>0?'+':'')+usd.format(n/100);
 const plain=s=>s?String(s).replaceAll('_',' ').toLowerCase().replace(/^./,v=>v.toUpperCase()):'';
 const known=s=>s&&!['UNKNOWN','UNDEFINED','CLOSED','OTHER'].includes(s);
 const sum=(xs,k)=>xs.reduce((t,x)=>t+x[k],0);
 const day=d=>new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
 const groups={returns:'Return claims',inr:'Item not received',other:'Other claims',review:'Needs review',credit:'Claim credits'};
 function group(x){return x.gross>0?'credit':x.type==='RETURN'?'returns':x.type==='ITEM_NOT_RECEIVED'?'inr':x.issue?'other':'review';}
 function link(url,name){return '<a href="'+esc(url)+'" target="_blank" rel="noopener">'+esc(name)+' ↗</a>';}
 const issueLink=(id,name)=>link('ebay-returns.html?caseId='+encodeURIComponent(id),name);
 function entry(x){
   const g=group(x),reason=known(x.reason)?plain(x.reason):'';
   const title=g==='credit'?'Credit from eBay':g==='review'?'Claim reason needs review':g==='returns'?'Return'+(reason?' · '+reason:''):g==='inr'?'Buyer reported item not received'+(reason?' · '+reason:''):plain(x.type)||'Other claim';
   const decisions=[];
   if(x.status)decisions.push('eBay: '+plain(x.status));
   if(known(x.seller))decisions.push('Seller: '+plain(x.seller));if(known(x.buyer))decisions.push('Buyer: '+plain(x.buyer));
   const why=x.other_order?'eBay’s charge names this order, but the saved case names '+x.other_order+'. '+(known(x.other_type)?'That case reports “'+plain(x.other_type)+'”'+(known(x.other_seller)?' (seller: '+plain(x.other_seller)+')':'')+'. ':'')+'Check both records before assigning a reason.':
     !x.ref?'eBay posted this credit to the order without a case number.':!x.issue?'The case reference is on the transaction; its reason is not verified for this order.':'';
   const canc=x.cancellation==='NONE_REQUESTED'?'No cancellation requested':known(x.cancellation)?'Cancellation: '+plain(x.cancellation):'Cancellation status not recorded';
   return '<li data-group="'+g+'"><header><div><strong>'+esc(title)+'</strong><small>'+esc(day(x.day))+' · '+(x.kind?esc(x.kind+' '+x.ref):'No case reference')+'</small></div><b class="wcl-'+(x.gross>0?'positive':'negative')+'">'+money(x.gross)+'</b></header>'+
     '<div class="wcl-order">'+link('https://www.ebay.com/mesh/ord/details?orderid='+encodeURIComponent(x.id),x.id)+(x.title?' · '+esc(x.title):'')+'</div>'+
     (decisions.length?'<p>'+esc(decisions.join(' · '))+'</p>':'')+'<small>'+esc(canc)+'</small>'+
     (why?'<p class="wcl-note">'+esc(why)+'</p>':'')+
     (x.fees||x.net!==x.gross?'<small>Fee credits / charges '+money(x.fees)+' · Net posted '+money(x.net)+'</small>':'')+
     (x.issue?issueLink(x.issue,'Open issue and timeline'):'')+(x.other_issue?issueLink(x.other_issue,'Inspect conflicting case'):'')+
     (x.related||[]).map(r=>issueLink(r.issue,'Same order · '+plain(r.lane)+' '+r.ref)).join(' · ')+'</li>';
 }
 function render(data){
   const control=data.ebay_cash_statement?.movements?.find(m=>/^gross claims$/i.test(m.label))||
     (data.ebay_cash_statement?.source==='eBay monthly financial statement'&&data.ebay_cash_statement.movements.find(m=>/^claims$/i.test(m.label)));
   const rows=data.ebay_claims?.rows,netBasis=control&&/^claims$/i.test(control.label);
   if(!control&&!rows)return '';
   const ok=Array.isArray(rows)&&control&&Number.isSafeInteger(control.cents)&&sum(rows,netBasis?'net':'gross')===control.cents;
   const open=root.location&&new URLSearchParams(root.location.search).get('view')==='claims';
   let contents;
   if(!ok)contents='<p>The statement '+(control?'shows <b>'+money(control.cents)+'</b> in '+(netBasis?'claims after fees':'gross claims'):'has no verified claims total')+'. '+(rows?'The saved entries no longer match; refresh the transaction export.':'Order details have not been verified for this month.')+'</p>';
   else{
     const debits=rows.filter(x=>x.gross<0),credits=rows.filter(x=>x.gross>0),gross=sum(rows,'gross'),fees=sum(rows,'fees');
     const net=sum(rows,'net'),extra=net-gross-fees;
     contents='<div class="wcl-totals">'+[[money(sum(debits,'gross')),debits.length+' charges'],[money(sum(credits,'gross')),credits.length+' credits'],[money(gross),netBasis?'Gross claims before fees':'Gross claims on statement']].map(([v,k])=>'<div><small>'+esc(k)+'</small><b>'+v+'</b></div>').join('')+'</div>'+
     '<p>These are eBay claim transactions posted this month, including claims on earlier purchases. Refunds and payment disputes posted under their own categories stay separate.</p>'+
     '<p>Fee credits / charges <b>'+money(fees)+'</b>'+(extra?' · Other differences between gross and net <b>'+money(extra)+'</b>':'')+' · Net account effect <b>'+money(net)+'</b>. Fee credits are already included in the account statement.</p>'+
     '<small>Choose a reason to see its orders</small><div class="wcl-filter" role="group" aria-label="Filter claim postings"><button type="button" data-filter="all" aria-pressed="true">All '+rows.length+'</button>'+
     Object.entries(groups).map(([g,label])=>{const xs=rows.filter(x=>group(x)===g);if(g==='returns'&&xs.length&&known(xs[0].reason)&&xs.every(x=>x.reason===xs[0].reason))label='Returns · '+plain(xs[0].reason);return xs.length?'<button type="button" data-filter="'+g+'" aria-pressed="false">'+esc(label)+' · '+xs.length+'<small>'+money(sum(xs,'gross'))+'</small></button>':'';}).join('')+'</div>'+
     '<details class="wcl-list" data-state="claims"'+(open?' open':'')+'><summary>Review '+rows.length+' postings by order <span>· '+new Set(rows.map(x=>x.id)).size+' orders</span></summary>'+
     '<small>Posting dates are Pacific. A buyer’s stated reason describes their claim; the case timeline shows the evidence.</small><ol>'+rows.map(entry).join('')+'</ol></details>';
   }
   return '<section class="wcl-panel" id="ws-claim-summary" tabindex="-1"><span class="wi-eyebrow">EBAY · CLAIM ACTIVITY</span><h4>What happened with claims?</h4>'+contents+'</section>';
 }
 function choose(section,g){
   for(const b of section.querySelectorAll('button[data-filter]'))b.setAttribute('aria-pressed',String(b.dataset.filter===g));
   for(const row of section.querySelectorAll('li[data-group]'))row.hidden=g!=='all'&&row.dataset.group!==g;
 }
 // Read only the Claim rows from eBay's original CSV. Quoted titles can span lines.
 function parseExport(text,period,requireCoverage=true){
   const records=[];let fields=[],s='',quoted=false;
   text=text.replace(/^\uFEFF/,'');
   for(let i=0;i<text.length;i++){const c=text[i];
     if(c==='"'){if(quoted&&text[i+1]==='"'){s+='"';i++;}else quoted=!quoted;}
     else if(!quoted&&c===','){fields.push(s);s='';}
     else if(!quoted&&(c==='\r'||c==='\n')){if(c==='\r'&&text[i+1]==='\n')i++;fields.push(s);records.push(fields);fields=[];s='';}
     else s+=c;
   }
   if(quoted)throw Error('Incomplete CSV. Download the original eBay transaction report.');
   if(s||fields.length){fields.push(s);records.push(fields);}
   const ix=records.findIndex(r=>r.includes('Transaction creation date')&&r.includes('Gross transaction amount'));
   if(ix<0||!records.slice(0,ix).some(r=>r[0]==='Seller'&&r[1]?.trim().toLowerCase()==='ogjewelers'))throw Error('Choose the original OG Jewelers eBay transaction report.');
   const months='Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
   if(requireCoverage){
     const bounds=k=>{const raw=records.slice(0,ix).find(r=>r[0]===k)?.[1]||'',m=/^([A-Z][a-z]{2})-(\d{1,2})-(\d{4})\b/.exec(raw);
       return m&&months.includes(m[1])?m[3]+'-'+String(months.indexOf(m[1])+1).padStart(2,'0')+'-'+m[2].padStart(2,'0'):'';};
     const start=bounds('Start date'),end=bounds('End date'),last=new Date(Date.UTC(+period.slice(0,4),+period.slice(5,7),0)).toISOString().slice(0,10);
     if(!start||!end||start>period+'-01'||end<last)throw Error('Choose an eBay transaction report with start and end dates covering the entire selected month.');
     if(!records.slice(0,ix).some(r=>r[0]==='This report includes transaction type'&&/\bclaim\b/i.test(r.slice(1).join(','))))throw Error('The transaction report must include Claim entries.');
   }
   const h=records[ix],feeFields=['Final Value Fee - fixed','Final Value Fee - variable','Regulatory operating fee','Very high "item not as described" fee','Below standard performance fee','International fee','Deposit processing fee'];
   const keys=['Transaction creation date','Type','Order number','Reference ID','Gross transaction amount','Transaction currency','Net amount','Payout currency',...feeFields];
   if(keys.some(k=>!h.includes(k)))throw Error('Missing transaction columns in the eBay CSV.');
   const entries=[];
   function cents(s,optional=false){if(optional&&['','--','-'].includes(s))return 0;
     if(!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s))throw Error('Unexpected amount on a claim transaction.');
     return Math.round(Number(s.replaceAll(',',''))*100);}
   for(const r of records.slice(ix+1)){const v=k=>r[h.indexOf(k)]?.trim();
     if(v('Type')!=='Claim')continue;
     const m=/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(v('Transaction creation date')||'');
     if(!m||!months.includes(m[1]))throw Error('Invalid claim date.');
     const day=m[3]+'-'+String(months.indexOf(m[1])+1).padStart(2,'0')+'-'+m[2].padStart(2,'0');
     if(!day.startsWith(period+'-'))continue;
     if(r.length!==h.length||v('Transaction currency')!=='USD'||v('Payout currency')!=='USD'||!/^\d{2}-\d{5}-\d{5}$/.test(v('Order number')))throw Error('Claim currency or order number could not be verified.');
     const raw=v('Reference ID'),ref=/^(Case|Request|Return) ID (\d{5,25})$/i.exec(raw);
     if(!ref&&!['--',''].includes(raw))throw Error('Unrecognized claim reference; check the original report.');
     entries.push({day,id:v('Order number'),kind:ref?plain(ref[1]):null,ref:ref?.[2]??null,gross:cents(v('Gross transaction amount')),net:cents(v('Net amount')),fees:feeFields.reduce((n,k)=>n+cents(v(k),true),0)});
   }
   return entries;
 }
 root.WeeklyEbayClaims={render,choose,parseExport};
})(typeof window!=='undefined'?window:globalThis);
