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
  function hasAftermarket(watch = {}) {
    const entered = [watch.modifications, watch.materials, watch.name].map(text).join('; ');
    return /\bafter[ -]?market\b/i.test(entered.replace(/\b(?:no|not|without|sin)\s+(?:any\s+)?after[ -]?market\b/gi, ''));
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
    return [...new Set([text(primary), ...stoneCategories(stone), hasAftermarket(watch || {}) && 'Aftermarket'].filter(Boolean))];
  }
  function watchTitle(watch = {}, stone = '', enteredTitle = '') {
    const sources = [watch.name, watch.model, watch.materials, watch.modifications];
    const brand = withoutSerial(watch.brand, sources);
    const name = withoutSerial(watch.name, sources);
    const model = withoutSerial(watch.model, sources);
    let entered = withoutSerial(enteredTitle, sources);
    // Rebuild our own suffix when stone type/modifications change in a draft.
    const suffix = entered.split(' — ');
    const qualifiers = new Set(['aftermarket', ...stoneChoices.map(value => value.toLowerCase())]);
    if (suffix.length > 1 && suffix.at(-1).split(', ').every(value => qualifiers.has(value.toLowerCase()))) entered = suffix.slice(0, -1).join(' — ');
    let title = entered || (brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? [brand, name].filter(Boolean).join(' ') : name || brand);
    if (model && !title.toLowerCase().includes(model.toLowerCase())) title = [title, model].filter(Boolean).join(' ');
    const extra = [];
    if (hasAftermarket(watch) && !/\bafter[ -]?market\b/i.test(title)) extra.push('Aftermarket');
    for (const category of stoneCategories(stone)) {
      if (category === 'No stone' || category === stoneChoices[2]) continue;
      if (!title.toLowerCase().includes(category.toLowerCase())) extra.push(category);
    }
    return [title, extra.join(', ')].filter(Boolean).join(' — ');
  }
  function watchDescription(description, watch = {}, stone = '') {
    // Older saves added the same facts again in a trailing Watch details block.
    let result = text(description).replace(/\n*Watch details:\s*\n[\s\S]*$/i, '').trim();
    const normalized = value => text(value).toLowerCase().replace(/[\s.,;:—–-]+/g, ' ').trim();
    const missing = [];
    const contains = value => normalized([result, ...missing].join(' ')).includes(normalized(value));
    const add = (value, label = '') => {
      const clean = text(value).replace(/[.\s]+$/, '');
      if (clean && !contains(clean)) missing.push(`${label}${clean}.`);
    };
    add(watch.materials, 'Materials: ');
    const modifications = text(watch.modifications);
    if (modifications) add(modifications, hasAftermarket({modifications}) ? '' : 'Modifications: ');
    if (hasAftermarket(watch) && !/\bafter[ -]?market\b/i.test([result, ...missing].join(' '))) add('Aftermarket modifications');
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
  root.InventoryItemFacts = { stoneChoices, withoutSerial, hasAftermarket, stoneCategories, categories, watchTitle, watchDescription };
})(globalThis);
