import * as core from './coin-ebay-core.mjs?v=20260926-coins-ebay';
window.CoinEbay = core;
let categoryPromise;
const metadataPromises = new Map();
async function invoke(body) {
  const { data, error } = await window.supabase.functions.invoke('ebay-inventory-sync', { body });
  if (error || !data?.ok) throw new Error(data?.error || error?.message || 'eBay requirements are unavailable. Try again.');
  return data;
}
function categories() {
  if (!categoryPromise) categoryPromise = invoke({action:'coinCategories'}).then(data => data.categories).catch(error => { categoryPromise = null; throw error; });
  return categoryPromise;
}
async function requirements(id) {
  if (!metadataPromises.has(id)) metadataPromises.set(id, invoke({action:'coinRequirements',categoryId:id}).catch(error => { metadataPromises.delete(id); throw error; }));
  return metadataPromises.get(id);
}
window.loadCoinEbayRequirements = requirements;
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function field(label, input) {
  const wrapper = element('label', '', 'coin-ebay-field');
  wrapper.append(element('span', label), input);
  return wrapper;
}
function createEditor(container, getCoin, changed, setCoinField = () => {}) {
  let listing = {}, metadata = null, allCategories = [], generation = 0;
  const search = element('input'); search.type = 'search'; search.placeholder = 'Search eBay coin categories (e.g. Morgan, Gold, Mexico)';
  const categorySelect = element('select'); categorySelect.setAttribute('data-coin-ebay-category','');
  const retry = element('button','Load / retry categories'); retry.type = 'button';
  const status = element('p','Choose the exact eBay coin category.','coin-ebay-status'); status.setAttribute('role','status');
  const specifics = element('div','','coin-ebay-specifics');
  const photoConfirm = element('input'); photoConfirm.type = 'checkbox'; photoConfirm.setAttribute('data-coin-ebay-photos','');
  const photos = field('Photos show the front and back of the actual coin being sold', photoConfirm); photos.classList.add('coin-ebay-confirm');
  const policy = element('a','eBay coin listing requirements'); policy.href='https://www.ebay.com/help/selling/selling-guides/selling-policies?id=4337'; policy.target='_blank'; policy.rel='noopener';
  container.replaceChildren(field('Find a coin category',search),field('eBay coin category',categorySelect),retry,status,specifics,photos,policy);
  function getDetails() {
    const coin = getCoin();
    return {...listing, conditionId: metadata ? core.coinConditionId({...coin,ebay:listing},metadata) : listing.conditionId || '',
      descriptors: {...(metadata ? core.seedCoinDescriptors(coin,metadata) : {}), ...(listing.descriptors || {})},
      photosConfirmed: photoConfirm.checked };
  }
  function notify() { changed?.(); document.dispatchEvent(new Event('add-item:wizard-change')); }
  function options() {
    categorySelect.replaceChildren(new Option('Choose the exact category…',''));
    const words=search.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const category of allCategories.filter(category => category.id === listing.categoryId || words.every(word => category.label.toLowerCase().includes(word)))) categorySelect.add(new Option(category.label,category.id));
    if (listing.categoryId && !allCategories.some(category => category.id === listing.categoryId)) categorySelect.add(new Option(listing.categoryLabel || `Saved coin category ${listing.categoryId}`,listing.categoryId));
    categorySelect.value=listing.categoryId || '';
  }
  function render() {
    specifics.replaceChildren();
    if (!metadata) return;
    const coin = {...getCoin(),ebay:getDetails()};
    const conditionId=core.coinConditionId(coin,metadata);
    const conditions=metadata.policy.itemConditions || [];
    const hasGrading=conditions.some(c=>String(c.conditionId)==='2750') && conditions.some(c=>String(c.conditionId)==='4000');
    if (hasGrading) specifics.append(element('p',`eBay condition: ${coin.gradingStatus === 'certified' ? 'Graded' : 'Ungraded'} (from the coin’s grading status).`));
    else if (conditions.length) {
      const select=element('select'); select.add(new Option('Choose condition',''));
      for (const condition of conditions) select.add(new Option(condition.conditionDescription,String(condition.conditionId)));
      select.value=conditionId;
      select.addEventListener('change',()=>{listing.conditionId=select.value;listing.descriptors={};render();notify();});
      specifics.append(field('eBay condition',select));
    } else specifics.append(element('p','This eBay category uses coin specifics instead of a condition selector.'));
    const policy=conditions.find(condition=>String(condition.conditionId)===conditionId);
    for (const descriptor of policy?.conditionDescriptors || []) {
      const id=String(descriptor.conditionDescriptorId), selected=coin.ebay.descriptors[id] || {}, constraints=descriptor.conditionDescriptorConstraint || {};
      const input=element(constraints.mode==='FREE_TEXT'?'input':'select'); input.setAttribute('data-coin-descriptor',id);
      if (constraints.mode==='FREE_TEXT') {input.maxLength=constraints.maxLength || 1000;input.value=selected.additionalInfo || '';}
      else {
        input.add(new Option('Choose…',''));
        for (const value of core.descriptorValues(descriptor,coin.ebay.descriptors)) input.add(new Option(value.conditionDescriptorValueName,String(value.conditionDescriptorValueId)));
        input.value=selected.values?.[0] || '';
      }
      input.addEventListener('change',()=>{
        listing.descriptors={...coin.ebay.descriptors,[id]:constraints.mode==='FREE_TEXT'?{additionalInfo:input.value}:{values:input.value?[input.value]:[]}};
        if (id==='3') listing.descriptors['4']={values:[]};
        const selectedName = (descriptor.conditionDescriptorValues || []).find(value=>String(value.conditionDescriptorValueId)===input.value)?.conditionDescriptorValueName || '';
        if (id==='1') setCoinField('gradingService',selectedName);
        if (id==='5') setCoinField('certNumber',input.value);
        if (id==='3' || id==='4') {
          const labelFor = key => policy.conditionDescriptors.find(d=>String(d.conditionDescriptorId)===key)?.conditionDescriptorValues?.find(v=>String(v.conditionDescriptorValueId)===listing.descriptors[key]?.values?.[0])?.conditionDescriptorValueName || '';
          setCoinField('grade',[labelFor('3'),labelFor('4')].filter(Boolean).join(' '));
        }
        render();notify();
      });
      specifics.append(field(`${descriptor.conditionDescriptorName}${constraints.usage==='REQUIRED'?' *':''}`,input));
      if (descriptor.conditionDescriptorHelpText) specifics.append(element('small',descriptor.conditionDescriptorHelpText));
    }
    const details=element('details'); details.open=true; details.append(element('summary','Coin specifics for this category'));
    const values={...core.suggestedCoinAspects(coin,metadata),...(listing.aspects || {})};
    for (const aspect of metadata.aspects) {
      const name=aspect.localizedAspectName;
      if (name==='California Prop 65 Warning') continue;
      const input=element(aspect.aspectConstraint?.aspectMode==='SELECTION_ONLY'?'select':'input'); input.setAttribute('data-coin-aspect',name);
      if (input.tagName==='SELECT') { input.add(new Option('Not specified','')); for (const value of aspect.aspectValues || []) input.add(new Option(value.localizedValue,value.localizedValue)); }
      else input.maxLength=aspect.aspectConstraint?.aspectMaxLength || 1000;
      input.value=values[name] || '';
      input.addEventListener('change',()=>{listing.aspects={...(listing.aspects||{}),[name]:input.value};notify();});
      details.append(field(`${name}${aspect.aspectConstraint?.aspectRequired?' *':''}`,input));
    }
    specifics.append(details);
  }
  async function load() {
    const version=++generation, id=listing.categoryId;
    metadata=null; specifics.replaceChildren(); status.textContent='Loading eBay categories and requirements…';
    try {
      allCategories=await categories();
      if(version!==generation)return;
      options();
      const loaded = id ? await requirements(id) : null;
      if(version!==generation)return;
      metadata=loaded;
      status.textContent=id?'Required fields are marked *. Confirm all details against the coin and its holder.':'Search and select a collector or bullion coin category.';
      render();notify();
    } catch(error) {if(version===generation){status.textContent=error.message;metadata=null;notify();}}
  }
  search.addEventListener('input',options);
  retry.addEventListener('click',load);
  categorySelect.addEventListener('change',()=>{
    const category=allCategories.find(entry=>entry.id===categorySelect.value);
    listing={...listing,categoryId:category?.id || '',categoryLabel:category?.label || '',aspects:{},descriptors:{},conditionId:''};
    notify();void load();
  });
  photoConfirm.addEventListener('change',notify);
  return { getDetails, getMetadata:()=>metadata, refresh:(key)=>{
      const resetIds={gradingService:['1'],grade:['3','4'],certNumber:['5'],gradingStatus:['1','2','3','4','5']}[key] || [];
      for(const id of resetIds) if(listing.descriptors) delete listing.descriptors[id];
      render();notify();
    },
    reset(coin={}, active=true){ ++generation;listing=structuredClone(coin.ebay || {});metadata=null;search.value='';photoConfirm.checked=listing.photosConfirmed===true;options();specifics.replaceChildren();if(active)void load(); },
  };
}
const addContainer=document.getElementById('coin-ebay-add');
if(addContainer){
  let reading=false;
  function baseCoin(){ reading=true;const coin=window.addItemWizard?.getCoinDetails() || {};reading=false;return coin; }
  const editor=createEditor(addContainer,baseCoin,()=>document.dispatchEvent(new CustomEvent('coin-ebay:change')), (key,value)=>{const input=document.getElementById(`coin-${key}`);if(input){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}});
  window.coinEbayForm={...editor,getDetails:()=>reading?undefined:editor.getDetails()};
  document.addEventListener('add-item:mode-change',event=>{
    addContainer.hidden=!event.detail.isCoin;
    document.querySelector('label[for="ebay-category-id"]').hidden=event.detail.isCoin;
    if(event.detail.isCoin && !event.detail.restoring)editor.reset(baseCoin());
  });
  for(const key of Object.keys(core.COIN_LABELS)) document.getElementById(`coin-${key}`)?.addEventListener('change',()=>editor.refresh(key));
  document.addEventListener('add-item-form:reset',()=>editor.reset({},false));
}
const stockContainer=document.getElementById('edit-coin-details');
if(stockContainer){
  let original={};
  const fields=element('div','','coin-ebay-fields'), sync=element('input');sync.type='checkbox';sync.id='edit-coin-ebay-enabled';
  const panel=element('div');stockContainer.append(fields,field('Include this coin in eBay sync',sync),panel);
  const controls={};
  for(const [key,label] of Object.entries(core.COIN_LABELS)){
    const input=element(key==='gradingStatus'?'select':'input');input.id=`edit-coin-${key}`;
    if(key==='gradingStatus') for(const [value,label] of [['ungraded','Raw / ungraded'],['self-assessed','Seller-assessed grade'],['certified','Third-party graded']])input.add(new Option(label,value));
    else input.maxLength=['notes','composition'].includes(key)?4000:300;
    controls[key]=input;fields.append(field(label,input));
  }
  const base=()=>({...original,...Object.fromEntries(Object.entries(controls).map(([key,input])=>[key,input.value.trim()]))});
  const editor=createEditor(panel,base,()=>{},(key,value)=>{if(controls[key])controls[key].value=value;});
  Object.entries(controls).forEach(([key,input])=>input.addEventListener('change',()=>editor.refresh(key)));
  window.coinEbayStock={
    open(item,editable){stockContainer.hidden=!editable || !item.coin_details;original=structuredClone(item.coin_details||{});for(const [key,input] of Object.entries(controls))input.value=original[key] || (key==='gradingStatus'?'ungraded':'');sync.checked=item.ebay_sync_enabled===true;editor.reset(original,editable&&!!item.coin_details);},
    getDetails:()=>({...base(),ebay:editor.getDetails()}),enabled:()=>sync.checked,
  };
}
