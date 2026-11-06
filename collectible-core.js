(function (root) {
  'use strict';
  const labels = {
    objectType: 'Object type', material: 'Gemstone / material', variety: 'Stone variety', color: 'Color',
    subject: 'Subject / design', height: 'Height', width: 'Width', depth: 'Depth',
    condition: 'Reported condition', conditionNotes: 'Damage / repairs', treatment: 'Known treatment',
    origin: 'Known origin', period: 'Known age / period', artist: 'Maker / artist', included: 'Included pieces', notes: 'Additional details',
  };
  const text = value => String(value ?? '').trim();
  const conditions = {1000:'NEW',1500:'NEW_OTHER',1750:'NEW_WITH_DEFECTS',2000:'CERTIFIED_REFURBISHED',2500:'SELLER_REFURBISHED',2750:'LIKE_NEW',3000:'USED_EXCELLENT',4000:'USED_VERY_GOOD',5000:'USED_GOOD',6000:'USED_ACCEPTABLE',7000:'FOR_PARTS_OR_NOT_WORKING'};
  function normalize(details = {}) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) details = {};
    const result = Object.fromEntries(Object.keys(labels).map(key => [key, text(details[key]).slice(0, ['notes','conditionNotes'].includes(key) ? 4000 : 300)]));
    result.dimensionUnit = details.dimensionUnit === 'in' ? 'in' : 'cm';
    return result;
  }
  function validate(details) {
    const errors = [];
    for (const key of ['objectType','material']) if (!text(details?.[key])) errors.push(`Enter ${labels[key].toLowerCase()}.`);
    for (const key of ['height','width','depth']) if (text(details?.[key]) && (!Number.isFinite(Number(details[key])) || Number(details[key]) <= 0)) errors.push(`${labels[key]} must be greater than zero.`);
    return errors;
  }
  const title = details => [text(details?.material), text(details?.objectType)].filter(Boolean).join(' ');
  function description(base, details, weight) {
    const clean = text(base).replace(/(?:^|\n\n)Carved gemstone details:\n[\s\S]*$/, '').trim();
    const normalized = normalize(details);
    const lines = Object.entries(labels).filter(([key]) => normalized[key]).map(([key, label]) => `${label}: ${normalized[key]}${['height','width','depth'].includes(key) ? ` ${normalized.dimensionUnit}` : ''}`);
    if (Number(weight) > 0) lines.push(`Total weight: ${Number(weight)} g`);
    return [clean, lines.length ? `Carved gemstone details:\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n');
  }
  function suggestedAspects(details, metadata) {
    const d = normalize(details);
    const known = {Type:d.objectType, Material:d.material, Color:d.color, Subject:d.subject, 'Country of Origin':d.origin,
      'Item Height':d.height && `${d.height} ${d.dimensionUnit}`, 'Item Width':d.width && `${d.width} ${d.dimensionUnit}`, 'Item Depth':d.depth && `${d.depth} ${d.dimensionUnit}`};
    const result = {};
    for (const aspect of metadata?.aspects || []) {
      const name = aspect.localizedAspectName, value = known[name];
      if (!value) continue;
      const match = aspect.aspectValues?.find(entry => entry.localizedValue.toLowerCase() === value.toLowerCase());
      if (aspect.aspectConstraint?.aspectMode !== 'SELECTION_ONLY' || match) result[name] = match?.localizedValue || value;
    }
    return result;
  }
  function listing(item, metadata) {
    const details = item.collectible_details || {}, ebay = details.ebay || {};
    const result = { categoryId:text(ebay.categoryId), aspects:{}, condition:null, reasons:[], description:description(item.description, details, item.weight) };
    if (!metadata || metadata.category?.id !== result.categoryId) {
      result.reasons.push('Choose and load the collectible eBay category requirements.'); return result;
    }
    const entered = {...suggestedAspects(details, metadata), ...(ebay.aspects || {})};
    for (const aspect of metadata.aspects || []) {
      const name = aspect.localizedAspectName, constraint = aspect.aspectConstraint || {};
      const values = (Array.isArray(entered[name]) ? entered[name] : [entered[name]]).map(text).filter(Boolean);
      if (!values.length && constraint.aspectRequired) result.reasons.push(`Missing ${name}.`);
      if (constraint.itemToAspectCardinality !== 'MULTI' && values.length > 1) result.reasons.push(`Choose one ${name}.`);
      for (const value of values) {
        if (constraint.aspectMaxLength && value.length > constraint.aspectMaxLength) result.reasons.push(`${name} is too long.`);
        if (constraint.aspectMode === 'SELECTION_ONLY' && !aspect.aspectValues?.some(option => option.localizedValue === value)) result.reasons.push(`Choose a supported ${name}.`);
        const option = aspect.aspectValues?.find(option => option.localizedValue === value);
        for (const dependent of option?.valueConstraints || []) {
          const other = entered[dependent.applicableForLocalizedAspectName];
          if (!(Array.isArray(other) ? other : [other]).some(v => dependent.applicableForLocalizedAspectValues?.includes(v))) result.reasons.push(`Check ${name} against ${dependent.applicableForLocalizedAspectName}.`);
        }
      }
      if (values.length) result.aspects[name] = values;
    }
    const policies = metadata.policy?.itemConditions || [];
    const condition = policies.find(option => String(option.conditionId) === String(ebay.conditionId));
    if (policies.length || metadata.policy?.itemConditionRequired) {
      if (!condition || !conditions[condition.conditionId]) result.reasons.push('Choose a supported eBay condition.');
      else {
        result.condition = conditions[condition.conditionId];
        if (condition.conditionDescriptors?.some(d => d.conditionDescriptorConstraint?.usage === 'REQUIRED')) result.reasons.push('This category requires additional condition descriptors; choose a supported collectible category before syncing.');
      }
    }
    result.reasons.push(...validate(details));
    return result;
  }
  root.CollectibleFacts = {labels, normalize, validate, title, description, suggestedAspects, listing, conditions};
})(typeof window === 'undefined' ? globalThis : window);
