// Shared by intake, Stock, exports and edge functions. Never infer stone origin from a photo.
(function (root) {
  const text = value => String(value || '').trim();
  const stoneChoices = ['Earth-mined diamonds', 'Lab-grown diamonds', 'Diamonds (origin unspecified)', 'VVS simulated diamonds', 'Simulated diamonds', 'Moissanite', 'Cubic zirconia', 'No stone'];
  const serialPattern = /\b(?:serial(?:\s*(?:number|no\.?|#))?|s\s*\/\s*n|n[uú]mero\s+de\s+serie)\s*[:#=]?\s*([a-z0-9][a-z0-9./-]*)/gi;
  function withoutSerial(value, sources = []) {
    let result = text(value).replace(serialPattern, '');
    for (const source of sources) {
      for (const match of text(source).matchAll(serialPattern)) {
        const escaped = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '');
      }
    }
    return result.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').replace(/^[\s,;|/—–-]+|[\s,;|/—–-]+$/g, '').trim();
  }
  function watchStoneSetting(watch = {}, stone = '') {
    if (/^(?:no stones?|none|not applicable)$/i.test(text(stone))) return '';
    // These explicit scopes include the setting, regardless of an older draft selection.
    if (['movement_only', 'aftermarket_stones'].includes(watch.modificationPreset)) return 'aftermarket';
    return ['factory', 'aftermarket'].includes(watch.stoneSetting) ? watch.stoneSetting : 'unknown';
  }
  function watchStoneSettingLabel(watch = {}, stone = '') {
    return {factory:'Factory-set stones', aftermarket:'Aftermarket stone setting', unknown:'Setting origin not confirmed'}[watchStoneSetting(watch, stone)] || 'Not applicable';
  }
  function watchCardStatus(watch = {}) {
    return ['yes','no'].includes(watch.cardIncluded) ? watch.cardIncluded : '';
  }
  function watchCardLabel(watch = {}) {
    return {yes:'Card included',no:'No card included'}[watchCardStatus(watch)] || 'Card not checked';
  }
  function hasAftermarket(watch = {}, stone = '') {
    const entered = [watchModifications(watch), watch.materials, watch.name].map(text).join('; ');
    return watchStoneSetting(watch, stone) === 'aftermarket' || /\bafter[ -]?market\b/i.test(entered.replace(/\b(?:no|not|without|sin)\s+(?:any\s+)?after[ -]?market\b/gi, ''));
  }
  function watchModifications(watch = {}) {
    const presets = {
      movement_only: `Only the ${text(watch.brand) || 'brand'} movement is original; all other parts are aftermarket`,
      aftermarket_bezel: 'Aftermarket bezel', aftermarket_dial: 'Aftermarket dial',
      aftermarket_bracelet: 'Aftermarket bracelet / strap', aftermarket_stones: 'Aftermarket stone setting',
    };
    const preset = presets[watch.modificationPreset] || '';
    const notes = text(watch.modificationNotes ?? watch.modifications);
    return preset && !notes.toLowerCase().includes(preset.toLowerCase()) ? [preset, notes].filter(Boolean).join('. ') : notes || preset;
  }
  function redactWatchSerial(value, watch = {}) {
    // Preserve paragraphs while removing a separately recorded private serial.
    let result = text(value).replace(serialPattern, '');
    const serial = text(watch.serial);
    if (serial) {
      const escaped = serial.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'gi'), '$1');
    }
    return result.replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n').trim();
  }
  function publicWatchDetails(watch = {}, stone = '') {
    const safe = Object.fromEntries(['name','brand','model','department','condition','materials','braceletFit'].map(key => [key, redactWatchSerial(watch[key], watch)]));
    safe.modifications = redactWatchSerial(watchModifications(watch), watch);
    safe.modificationNotes = redactWatchSerial(watch.modificationNotes ?? watch.modifications, watch);
    safe.modificationPreset = text(watch.modificationPreset);
    safe.stoneSetting = watchStoneSetting(watch, stone);
    safe.cardIncluded = watchCardStatus(watch);
    return safe;
  }
  function stoneCategories(value) {
    const s = text(value).toLowerCase();
    if (!s || /\b(?:unknown|unconfirmed|unsure|not sure|not natural|not earth|not lab)\b/.test(s)) return [];
    if (/^(?:no stones?|none|not applicable)$/.test(s)) return ['No stone'];
    const categories = [];
    if (/\b(?:earth[ -]?(?:mined|natural)|natural|mined)\s+diamonds?\b/.test(s)) categories.push(stoneChoices[0]);
    if (/\blab(?:oratory)?[ -]?(?:grown[ -]?|created[ -]?)?diamonds?\b/.test(s)) categories.push(stoneChoices[1]);
    if (/\bvvs\s+simulated\s+diamonds?\b|\bsimulated\s+diamonds?\s+vvs\b/.test(s)) categories.push('VVS simulated diamonds');
    else if (/\bsimulated\s+diamonds?\b/.test(s) && !/\bcubic zirconia\b|\bcz\b/.test(s)) categories.push('Simulated diamonds');
    if (/\bmoissanite\b/.test(s)) categories.push('Moissanite');
    if (/\bcubic zirconia\b|\bcz\b/.test(s)) categories.push('Cubic zirconia');
    if (!categories.length && /\bdiamonds?\b/.test(s) && !/\b(?:simulated|imitation|fake)\b/.test(s)) categories.push(stoneChoices[2]);
    return categories;
  }
  function categories(primary, stone, watch) {
    return [...new Set([text(primary), ...stoneCategories(stone), hasAftermarket(watch || {}, stone) && 'Aftermarket'].filter(Boolean))];
  }
  function watchTitle(watch = {}, stone = '', enteredTitle = '') {
    enteredTitle = redactWatchSerial(enteredTitle, watch);
    // Keep legacy serial annotations available to strip bare serials in edited titles.
    enteredTitle = withoutSerial(enteredTitle, [watch.name, watch.model, watch.materials, watch.modifications]);
    watch = publicWatchDetails(watch, stone);
    const sources = [watch.name, watch.model, watch.materials, watch.modifications];
    const brand = withoutSerial(watch.brand, sources);
    const name = withoutSerial(watch.name, sources);
    const model = withoutSerial(watch.model, sources);
    let entered = withoutSerial(enteredTitle, sources);
    // Rebuild our own suffix when stone type/modifications change in a draft.
    const suffix = entered.split(' — ');
    const qualifiers = new Set(['aftermarket', 'aftermarket-set stones', 'factory-set stones', ...stoneChoices.map(value => value.toLowerCase())]);
    if (suffix.length > 1 && suffix.at(-1).split(', ').every(value => qualifiers.has(value.toLowerCase()))) entered = suffix.slice(0, -1).join(' — ');
    let title = entered || (brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? [brand, name].filter(Boolean).join(' ') : name || brand);
    if (model && !title.toLowerCase().includes(model.toLowerCase())) title = [title, model].filter(Boolean).join(' ');
    const extra = [];
    const setting = watchStoneSetting(watch, stone);
    if (setting === 'aftermarket' && stone && !/aftermarket[ -]set stones/i.test(title)) extra.push('Aftermarket-set stones');
    else if (hasAftermarket(watch, stone) && !/\bafter[ -]?market\b/i.test(title)) extra.push('Aftermarket');
    for (const category of stoneCategories(stone)) {
      if (category === 'No stone' || category === stoneChoices[2]) continue;
      if (!title.toLowerCase().includes(category.toLowerCase())) extra.push(category);
    }
    if (setting === 'factory' && stone && !/factory[ -]set stones/i.test(title)) extra.push('Factory-set stones');
    return [title, extra.join(', ')].filter(Boolean).join(' — ');
  }
  function watchDescription(description, watch = {}, stone = '') {
    // Older saves added the same facts again in a trailing Watch details block.
    let result = redactWatchSerial(description, watch).replace(/\n*Watch details:\s*\n[\s\S]*$/i, '').trim();
    watch = publicWatchDetails(watch, stone);
    const normalized = value => text(value).toLowerCase().replace(/[\s.,;:—–-]+/g, ' ').trim();
    const missing = [];
    const contains = value => normalized([result, ...missing].join(' ')).includes(normalized(value));
    const add = (value, label = '') => {
      const clean = text(value).replace(/[.\s]+$/, '');
      if (clean && !contains(clean)) missing.push(`${label}${clean}.`);
    };
    add(watch.materials, 'Materials: ');
    add(watch.braceletFit, 'Measured bracelet / wrist fit: ');
    // Keep the current physical item's choice authoritative, including common AI wording.
    let cardDescribed = false;
    result = result.replace(/\b(?:no|without)\s+(?:an?\s+|the\s+)?(?:(?:original|brand|warranty)[\s/]+)*cards?\b(?:\s+(?:is\s+)?included)?[.!]?\s*|\b(?:(?:original|brand|warranty)[\s/]+)*cards?\s+(?:is\s+)?(?:not )?included\b[.!]?\s*|\b(?:with|includes?|including|accompanied by)\s+(?:an?\s+|the\s+)?(?:(?:original|brand|warranty)[\s/]+)*cards?\b[.!]?\s*/gi, statement => {
      const negative = /^(?:no|without)\b|\bnot included\b/i.test(statement);
      const matching = negative ? watch.cardIncluded === 'no' : watch.cardIncluded === 'yes';
      cardDescribed ||= matching;
      return matching ? statement : '';
    }).trim();
    if (!cardDescribed && watch.cardIncluded === 'yes') add('Original brand / warranty card included');
    if (!cardDescribed && watch.cardIncluded === 'no') add('No brand / warranty card included');
    const preset = watchModifications({...watch, modificationNotes:''});
    const modifications = text(watch.modificationNotes).replace(preset, '').replace(/^[.\s]+/, '');
    const movementScopePresent = watch.modificationPreset === 'movement_only'
      && /(?:original[^.!?;\n]{0,40}movement|movement[^.!?;\n]{0,20}original)/i.test(result)
      && /all (?:the )?other (?:parts|components) (?:are )?after[ -]?market/i.test(result);
    if (preset && !movementScopePresent) add(preset);
    if (modifications) add(modifications, hasAftermarket({modifications}) || preset ? '' : 'Modifications: ');
    const setting = watchStoneSetting(watch, stone);
    const settingCopy = [result, ...missing].join(' ');
    const settingDescribed = setting === 'factory'
      ? /\bfactory[ -]set\s+(?:[\w-]+\s+){0,3}(?:diamonds?|stones?)\b|\b(?:diamonds?|stones?)\s+(?:are\s+)?factory[ -]set\b/i.test(settingCopy)
      : /\baftermarket[ -](?:set\s+)?(?:[\w-]+\s+){0,3}(?:diamonds?|stones?|setting)\b|\b(?:diamonds?|stones?)\s+(?:are\s+)?aftermarket[ -]set\b/i.test(settingCopy);
    if (['factory','aftermarket'].includes(setting) && !settingDescribed && !(watch.modificationPreset === 'movement_only' && !stone)) add(watchStoneSettingLabel(watch, stone));
    if (hasAftermarket(watch, stone) && !/\bafter[ -]?market\b/i.test([result, ...missing].join(' '))) add('Aftermarket modifications');
    const stones = stoneCategories(stone);
    const alreadyDescribed = stoneCategories([result, ...missing].join(' '));
    const isPreset = stoneChoices.some(choice => normalized(choice) === normalized(stone));
    const equivalentStone = isPreset && stones.length && stones.every(category => category === stoneChoices[2] ? contains(category) : alreadyDescribed.includes(category));
    if (stone && !equivalentStone) add(stone, 'Stones: ');
    // Remove identical paragraphs, while preserving distinct worker-entered notes.
    const paragraphs = [...result.split(/\n\s*\n/), missing.join(' ')].filter(Boolean);
    const seen = new Set();
    return paragraphs.filter(p => {const key=normalized(p);if(seen.has(key))return false;seen.add(key);return true;}).join('\n\n');
  }
  root.InventoryItemFacts = { stoneChoices, withoutSerial, hasAftermarket, stoneCategories, categories, watchStoneSetting, watchStoneSettingLabel, watchCardStatus, watchCardLabel, watchModifications, redactWatchSerial, publicWatchDetails, watchTitle, watchDescription };
})(globalThis);
