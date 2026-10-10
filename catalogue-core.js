(function (root) {
  'use strict';
  const categories=['Watches','Rings','Pendants','Chains','Necklaces','Bracelets','Earrings','Anklets','Brooches','Sets','Coins','Other'];
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(value)||0);
  function totals(items,selected,credit){
    const cents=items.reduce((sum,i)=>sum+(selected.has(i.id)?Math.round(Number(i.retail_price)*100):0),0);
    const available=Math.max(0,Math.round(Number(credit||0)*100));
    return{total:cents/100,applied:Math.min(cents,available)/100,remaining:Math.max(0,available-cents)/100,due:Math.max(0,cents-available)/100,count:items.filter(i=>selected.has(i.id)).length};
  }
  function filter(items,{search='',category='',min='',max='',sort='curated',selectedOnly=false,selected=new Set()}={}){
    const needle=search.trim().toLowerCase();
    const result=items.filter(i=>(!needle || `${i.name} ${i.description}`.toLowerCase().includes(needle)) && (!category || i.category===category) && (min==='' || Number(i.retail_price)>=Number(min)) && (max==='' || Number(i.retail_price)<=Number(max)) && (!selectedOnly || selected.has(i.id)));
    if(sort==='price-low')result.sort((a,b)=>a.retail_price-b.retail_price);
    if(sort==='price-high')result.sort((a,b)=>b.retail_price-a.retail_price);
    if(sort==='name')result.sort((a,b)=>a.name.localeCompare(b.name));
    return result;
  }
  const safeImage=url=>{try{const u=new URL(url);return u.protocol==='https:' || (u.origin===root.location?.origin && u.protocol==='http:')?u.href:'';}catch{return '';}};
  function card(item,selected=false){
    const img=safeImage(item.images?.[0]);
    const photos=(item.images||[]).map(safeImage).filter(Boolean).length;
    return `<article class="jewel-card ${selected?'is-selected':''}"><button class="jewel-photo" data-details="${escape(item.id)}" data-photos="${escape(item.id)}" aria-label="View ${escape(item.name)}">${img?`<img src="${escape(img)}" alt="${escape(item.name)}" loading="lazy" decoding="async">`:'<span>Photo unavailable</span>'}${selected?'<span class="selected-seal">✓ Selected</span>':''}<span class="photo-hint">${photos>1?`${photos} photographs · `:''}Zoom into piece ↗</span></button><div class="jewel-copy"><p class="eyebrow">${escape(item.category)}</p><button class="jewel-name" data-details="${escape(item.id)}">${escape(item.name)}</button><p class="jewel-description">${escape(item.description)}</p><div class="jewel-price"><span>${money(item.retail_price)}</span><small>Retail · USD</small></div><button class="choose-piece ${selected?'chosen':''}" data-select="${escape(item.id)}" aria-pressed="${selected}">${selected?'✓ In your selection':'＋ Select this piece'}</button></div></article>`;
  }
  // Match the piece itself before broad inventory tags (a chain bracelet is a bracelet).
  // Keep these rules aligned with catalogue_piece_type in the database migration.
  function categoryFor(item){
    if(categories.includes(item.piece_type))return item.piece_type;
    const rules=[[/\b(watch|watches|wristwatch|wristwatches)\b/i,'Watches'],[/\b(earring|earrings|studs)\b/i,'Earrings'],[/\b(anklet|anklets)\b/i,'Anklets'],[/\b(bracelet|bracelets|bangle|bangles|cuff)\b/i,'Bracelets'],[/\b(pendant|pendants|charm|charms)\b/i,'Pendants'],[/\b(chain|chains)\b/i,'Chains'],[/\b(necklace|necklaces)\b/i,'Necklaces'],[/\b(ring|rings)\b/i,'Rings'],[/\b(brooch|brooches)\b/i,'Brooches'],[/\b(set|sets)\b/i,'Sets'],[/\b(coin|coins|bullion)\b/i,'Coins']];
    for(const text of [item.title||item.name||'',(item.categories||[]).join(' ')])for(const[pattern,type]of rules)if(pattern.test(text))return type;
    return 'Other';
  }
  function clientCategory(item){
    // Older catalogues grouped chains and pendants under Necklaces.
    const inferred=categoryFor(item);
    return item.category==='Necklaces' && ['Chains','Pendants'].includes(inferred)?inferred:item.category;
  }
  function purityLabel(value,metal){
    if(value==='unspecified'||value==null)return 'Not specified';
    const bp=Number(value),karats={4167:10,5833:14,7500:18,9167:22,10000:24};
    if(metal==='gold' && karats[bp])return `${karats[bp]}K gold`;
    const fine=Number((bp/10).toFixed(2));
    return `${fine}${metal==='silver'&&bp===9250?' sterling silver':metal?` ${metal}`:' fineness'}`;
  }
  root.Catalogue={categories,escape,money,totals,filter,card,safeImage,categoryFor,clientCategory,purityLabel};
})(typeof window==='undefined'?globalThis:window);
