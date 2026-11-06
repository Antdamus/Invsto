(() => {
  'use strict';
  const core = window.CollectibleFacts, $ = id => document.getElementById(id);
  const section = document.createElement('div'); section.id = 'collectible-fields'; section.hidden = true;
  section.innerHTML = `<p class="field-helper">Vases, sculptures, figurines and other carved gemstone collectibles. Enter what is known about this piece.</p><div class="form-grid form-grid-2"></div>`;
  $('jewelry-material-fields').before(section);
  const grid = section.querySelector('.form-grid');
  const choices = {objectType:['Vase','Sculpture','Figurine','Carving','Bowl','Snuff bottle','Obelisk','Sphere','Other'],material:['Jade','Quartz','Rose quartz','Amethyst','Agate','Lapis lazuli','Malachite','Onyx','Other / mixed'],variety:['Jadeite','Nephrite','Unknown'],condition:['New','Pre-owned','Damaged','Unknown'],treatment:['Unknown','None known','Dyed','Resin impregnated','Other']};
  const placeholders = {variety:'e.g. jadeite or nephrite, if known',subject:'e.g. floral relief, dragon',origin:'Country or region, if known',period:'Only enter a known date or period',conditionNotes:'Chips, cracks, repairs, wear or other damage',included:'e.g. matching lid, display stand',artist:'Known maker or signature'};
  for (const [key, label] of Object.entries({...core.labels,dimensionUnit:'Measurement unit'})) {
    const wrapper = document.createElement('label'); wrapper.className = 'form-field'; wrapper.htmlFor = `collectible-${key}`;
    const caption = document.createElement('span'); caption.className = 'form-label'; caption.textContent = label;
    const input = document.createElement(['notes','conditionNotes'].includes(key) ? 'textarea' : key === 'dimensionUnit' ? 'select' : 'input');
    input.id = wrapper.htmlFor; input.className = 'add-input'; input.disabled = true;
    if (key === 'dimensionUnit') { input.add(new Option('Centimeters (cm)','cm')); input.add(new Option('Inches (in)','in')); }
    else {
      input.maxLength = ['notes','conditionNotes'].includes(key) ? 4000 : 300;
      if (['height','width','depth'].includes(key)) { input.type = 'number'; input.min = '0.01'; input.step = 'any'; input.inputMode = 'decimal'; }
      input.placeholder = placeholders[key] || (key === 'objectType' ? 'e.g. Vase' : key === 'material' ? 'e.g. Jade' : 'Optional');
    }
    wrapper.append(caption,input);
    if (choices[key]) {
      const list = document.createElement('datalist'); list.id = `collectible-${key}-options`;
      for (const value of choices[key]) list.append(new Option(value,value));
      input.setAttribute('list',list.id); wrapper.append(list);
    }
    grid.append(wrapper);
  }
  const unit = $('collectible-dimensionUnit').closest('label'); $('collectible-height').closest('label').before(unit);
  const optional = document.createElement('details'); optional.className = 'item-optional-details';
  optional.innerHTML = '<summary>Gemstone details and provenance (optional)</summary><div class="form-grid form-grid-2"></div>';
  for (const key of ['variety','color','subject','treatment','origin','period','artist','included','notes']) optional.lastElementChild.append($(`collectible-${key}`).closest('label'));
  section.append(optional);
  // Specifics remain optional for inventory; eBay validates the chosen category separately.
  let ebay = {}, metadata = null, generation = 0, searchGeneration = 0;
  const container = $('collectible-ebay-add');
  container.innerHTML = `<label class="form-field"><span class="form-label">Find the right eBay category</span><input id="collectible-ebay-search" class="add-input" placeholder="e.g. carved jade vase or gemstone sculpture" maxlength="200"></label><button type="button" id="collectible-ebay-find" class="add-button-secondary">Search eBay categories</button><label class="form-field"><span class="form-label">eBay category</span><select id="collectible-ebay-category" class="add-input"><option value="">Search and choose a category…</option></select></label><button type="button" id="collectible-ebay-retry" class="add-button-secondary">Reload requirements</button><p id="collectible-ebay-status" class="field-helper" role="status">Choose a category based on the actual piece. A carving is not automatically an antique.</p><div id="collectible-ebay-specifics" class="form-grid form-grid-2"></div>`;
  const active = () => document.querySelector('[name="item-kind"]:checked')?.value === 'collectible';
  const getDetails = () => active() ? {...core.normalize(Object.fromEntries([...Object.keys(core.labels),'dimensionUnit'].map(key => [key,$(`collectible-${key}`).value]))),ebay:structuredClone(ebay)} : null;
  function notify() { document.dispatchEvent(new Event('collectible-ebay:change')); document.dispatchEvent(new Event('add-item:wizard-change')); }
  async function invoke(body) {
    const {data,error} = await window.supabase.functions.invoke('ebay-inventory-sync',{body});
    if (error || !data?.ok) throw new Error(data?.error || error?.message || 'eBay categories are unavailable. Try again.');
    return data;
  }
  function render() {
    const target = $('collectible-ebay-specifics'); target.replaceChildren();
    if (!metadata) return;
    function field(label, input) {
      const wrap = document.createElement('label'), span = document.createElement('span');
      wrap.className = 'form-field'; span.className = 'form-label'; span.textContent = label; input.className = 'add-input'; wrap.append(span,input); target.append(wrap);
    }
    const policies = metadata.policy?.itemConditions || [];
    if (policies.length) {
      const condition = document.createElement('select'); condition.id = 'collectible-ebay-condition'; condition.add(new Option('Choose condition…',''));
      for (const policy of policies) condition.add(new Option(policy.conditionDescription,String(policy.conditionId)));
      condition.value = ebay.conditionId || '';
      condition.addEventListener('change', () => { ebay.conditionId = condition.value; notify(); }); field('eBay condition',condition);
    }
    const values = {...core.suggestedAspects(getDetails(),metadata),...(ebay.aspects || {})};
    for (const aspect of metadata.aspects) {
      const name = aspect.localizedAspectName, constraint = aspect.aspectConstraint || {};
      const input = document.createElement(constraint.aspectMode === 'SELECTION_ONLY' ? 'select' : 'input');
      input.dataset.collectibleAspect = name;
      if (input.tagName === 'SELECT') {
        input.multiple = constraint.itemToAspectCardinality === 'MULTI';
        if (!input.multiple) input.add(new Option('Not specified',''));
        for (const option of aspect.aspectValues || []) input.add(new Option(option.localizedValue,option.localizedValue));
        if (input.multiple) for (const option of input.options) option.selected = (Array.isArray(values[name]) ? values[name] : [values[name]]).includes(option.value);
        else input.value = values[name] || '';
      } else { input.maxLength = constraint.aspectMaxLength || 1000; input.value = values[name] || ''; }
      input.addEventListener('change', () => { ebay.aspects = {...(ebay.aspects || {}),[name]:input.multiple ? [...input.selectedOptions].map(option => option.value) : input.value}; notify(); });
      field(`${name}${constraint.aspectRequired ? ' *' : ''}`,input);
    }
  }
  async function loadRequirements() {
    const revision = ++generation, id = ebay.categoryId; metadata = null; render(); notify();
    if (!id) return;
    $('collectible-ebay-status').textContent = 'Loading category specifics and conditions…';
    try {
      const result = await invoke({action:'collectibleRequirements',categoryId:id});
      if (revision !== generation) return;
      metadata = result; ebay.categoryLabel = result.category.label;
      $('collectible-ebay-status').textContent = 'Required eBay specifics are marked *. Confirm the details for this piece.'; render(); notify();
    } catch (error) { if (revision === generation) { $('collectible-ebay-status').textContent = error.message; notify(); } }
  }
  async function search() {
    const query = $('collectible-ebay-search').value.trim() || core.title(getDetails());
    if (!query) { $('collectible-ebay-status').textContent = 'Enter an object and material, such as carved jade vase.'; return; }
    const revision = ++searchGeneration; $('collectible-ebay-status').textContent = 'Searching eBay categories…';
    try {
      const result = await invoke({action:'collectibleCategories',query});
      if (revision !== searchGeneration) return;
      const select = $('collectible-ebay-category'); select.replaceChildren(new Option('Choose the category for this piece…',''));
      if (ebay.categoryId) select.add(new Option(ebay.categoryLabel,ebay.categoryId));
      for (const category of result.categories) if (![...select.options].some(option => option.value === category.id)) select.add(new Option(category.label,category.id));
      select.value = ebay.categoryId || '';
      $('collectible-ebay-status').textContent = result.categories.length ? 'Choose the category that describes your piece. No category is selected automatically.' : 'No matches. Try different words, such as gemstone carving or stone vase.';
    } catch (error) { if (revision === searchGeneration) $('collectible-ebay-status').textContent = error.message; }
  }
  $('collectible-ebay-find').addEventListener('click',search);
  $('collectible-ebay-search').addEventListener('keydown',event => { if (event.key === 'Enter') { event.preventDefault(); void search(); } });
  $('collectible-ebay-retry').addEventListener('click',loadRequirements);
  $('collectible-ebay-category').addEventListener('change',event => { ebay = {categoryId:event.target.value,categoryLabel:event.target.selectedOptions[0]?.textContent || '',aspects:{},conditionId:''}; void loadRequirements(); });
  function restore(details = {}) {
    ++generation; ++searchGeneration; metadata = null;
    const normalized = core.normalize(details);
    for (const [key,value] of Object.entries(normalized)) $(`collectible-${key}`).value = value;
    ebay = structuredClone(details.ebay || {});
    $('collectible-ebay-search').value = '';
    $('collectible-ebay-category').replaceChildren(new Option('Search and choose a category…',''));
    if (ebay.categoryId) $('collectible-ebay-category').add(new Option(ebay.categoryLabel || ebay.categoryId,ebay.categoryId));
    $('collectible-ebay-category').value = ebay.categoryId || '';
    render();
  }
  function updateMode() {
    const enabled = active(); section.hidden = !enabled; container.hidden = !enabled;
    section.querySelectorAll('input,select,textarea').forEach(input => { input.disabled = !enabled; input.required = enabled && ['collectible-objectType','collectible-material'].includes(input.id); });
    if (enabled && ebay.categoryId && !metadata) void loadRequirements();
  }
  document.addEventListener('add-item:mode-change',updateMode);
  document.addEventListener('add-item-form:reset', () => restore());
  window.collectibleIntake = {active,getDetails,restore,updateMode,getMetadata:()=>metadata};
})();
