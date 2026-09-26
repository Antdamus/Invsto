// Shared by intake, Stock, CSV export and the eBay Inventory API.
// Descriptor IDs and allowed values are validated against live eBay metadata.
export const COIN_LABELS = { name: 'Name / series', year: 'Year / date', country: 'Issuing country', denomination: 'Denomination', mint: 'Mint / mint mark', metal: 'Metal', fineness: 'Purity (parts per 1,000)', condition: 'Reported condition', variety: 'Variety / reference', finish: 'Strike / finish', fineMetalContent: 'Fine metal content', composition: 'Composition details', gradingStatus: 'Grading status', grade: 'Grade as stated', gradingService: 'Grading service', certNumber: 'Certification number', notes: 'Condition notes / alterations' };
export const CONDITION_ENUMS = { '1000':'NEW', '1500':'NEW_OTHER', '1750':'NEW_WITH_DEFECTS', '2500':'SELLER_REFURBISHED', '2750':'LIKE_NEW', '2990':'PRE_OWNED_EXCELLENT', '3000':'USED_EXCELLENT', '3010':'PRE_OWNED_FAIR', '4000':'USED_VERY_GOOD', '5000':'USED_GOOD', '6000':'USED_ACCEPTABLE', '7000':'FOR_PARTS_OR_NOT_WORKING' };
const text = value => String(value ?? '').trim();
export function coinConditionId(coin, metadata) {
  const conditions = metadata?.policy?.itemConditions || [];
  if (!conditions.length) return '';
  const gradedId = coin.gradingStatus === 'certified' ? '2750' : '4000';
  if (conditions.some(c => String(c.conditionId) === gradedId)) return gradedId;
  return text(coin.ebay?.conditionId);
}
export function descriptorValues(descriptor, selections = {}) {
  return (descriptor.conditionDescriptorValues || []).filter(value =>
    (value.conditionDescriptorValueConstraints || []).every(rule =>
      (selections[rule.applicableToConditionDescriptorId]?.values || []).some(id => rule.applicableToConditionDescriptorValueIds?.map(String).includes(String(id)))
    )
  );
}
export function suggestedCoinAspects(coin, metadata) {
  const values = { Year: coin.year, Composition: coin.metal, Denomination: coin.denomination, 'Country of Origin': coin.country, 'Mint Location': coin.mint, 'Brand/Mint': coin.mint, 'Strike Type': coin.finish, Variety: coin.variety, Coin: coin.name,
    Fineness: coin.fineness && Number(coin.fineness) > 0 && Number(coin.fineness) <= 1000 ? String(Number(coin.fineness) / 1000) : '',
    'Precious Metal Content per Unit': coin.fineMetalContent,
    Certification: coin.gradingStatus === 'certified' ? coin.gradingService : 'Uncertified',
    Grade: coin.gradingStatus === 'certified' ? coin.grade : '',
    'Certification Number': coin.gradingStatus === 'certified' ? coin.certNumber : '',
  };
  const aspects = {};
  for (const aspect of metadata?.aspects || []) {
    const name = aspect.localizedAspectName;
    let value = text(values[name]);
    if (value && aspect.aspectConstraint?.aspectMode === 'SELECTION_ONLY') value = aspect.aspectValues?.find(entry => entry.localizedValue.toLowerCase() === value.toLowerCase())?.localizedValue || '';
    if (value) aspects[name] = value;
  }
  return aspects;
}
export function buildCoinListing(item, metadata) {
  const coin = item.coin_details || {};
  const configured = coin.ebay || {};
  const reasons = [];
  if (!metadata?.category || metadata.category.id !== text(configured.categoryId ?? item.ebay_category_id)) return { reasons: ['choose and load the coin eBay category'], aspects: {}, conditionDescriptors: [] };
  const aspects = {};
  const values = { ...suggestedCoinAspects(coin, metadata), ...(configured.aspects || {}) };
  for (const aspect of metadata.aspects || []) {
    const name = aspect.localizedAspectName;
    const value = text(values[name]);
    if (!value && aspect.aspectConstraint?.aspectRequired) reasons.push(`missing ${name}`);
    if (!value) continue;
    if (aspect.aspectConstraint?.aspectMaxLength && value.length > aspect.aspectConstraint.aspectMaxLength) reasons.push(`${name} is too long`);
    if (aspect.aspectConstraint?.aspectMode === 'SELECTION_ONLY' && !aspect.aspectValues?.some(entry => entry.localizedValue === value)) reasons.push(`choose a valid ${name}`);
    aspects[name] = [value];
  }
  const conditionId = coinConditionId(coin, metadata);
  const conditionPolicy = metadata.policy.itemConditions?.find(entry => String(entry.conditionId) === conditionId);
  if ((metadata.policy.itemConditionRequired || conditionId) && (!conditionPolicy || !CONDITION_ENUMS[conditionId])) reasons.push('choose a supported coin condition');
  const conditionDescriptors = [];
  const descriptorLabels = [];
  for (const descriptor of conditionPolicy?.conditionDescriptors || []) {
    const id = String(descriptor.conditionDescriptorId);
    const name = descriptor.conditionDescriptorName;
    const selected = configured.descriptors?.[id] || {};
    const constraints = descriptor.conditionDescriptorConstraint || {};
    if (constraints.mode === 'FREE_TEXT') {
      const value = text(selected.additionalInfo);
      if (!value && constraints.usage === 'REQUIRED') reasons.push(`missing ${name}`);
      if (value.length > (constraints.maxLength || 1000)) reasons.push(`${name} is too long (maximum ${constraints.maxLength})`);
      if (value) { conditionDescriptors.push({ name: id, additionalInfo: value }); descriptorLabels.push(`${name}: ${value}`); }
    } else {
      const selectedValues = (Array.isArray(selected.values) ? selected.values : []).map(String);
      if (!selectedValues.length && constraints.usage === 'REQUIRED') reasons.push(`missing ${name}`);
      if (constraints.cardinality === 'SINGLE' && selectedValues.length > 1) reasons.push(`choose one ${name}`);
      const allowed = descriptorValues(descriptor, configured.descriptors);
      if (selectedValues.some(value => !allowed.some(entry => String(entry.conditionDescriptorValueId) === value))) reasons.push(`choose a valid ${name} for the selected grade`);
      if (selectedValues.length) {
        conditionDescriptors.push({ name: id, values: selectedValues });
        descriptorLabels.push(`${name}: ${selectedValues.map(value => allowed.find(entry => String(entry.conditionDescriptorValueId) === value)?.conditionDescriptorValueName || '').join(', ')}`);
      }
    }
  }
  if (!text(coin.name)) reasons.push('missing coin name');
  const photoPaths = [...(item.photos || item.photoPaths || []), item.photo_url].filter(Boolean).map(value => String(value).split('?')[0]);
  if (new Set(photoPaths).size < 2) reasons.push('add separate front and back photos of the actual coin');
  if (configured.photosConfirmed !== true) reasons.push('confirm that photos show the front and back of the actual coin');
  // Collector categories classify raw coins explicitly; bullion categories have their own policy.
  if (conditionId === '4000' && Number(item.sale_price) >= 2500) reasons.push('raw collector coins must have a retail price below $2,500 under eBay currency rules');
  // Seller assessments remain internal and must not be promoted as a certified numeric grade.
  const raw = coin.gradingStatus !== 'certified';
  let title = text(item.title);
  const baseDescription = text(item.description).replace(/\n*Coin details:\n[\s\S]*$/, '').trim();
  const gradeClaim = /\b(?:MS|PR|PF|SP|AU|XF|EF|VF|VG|AG|FR)\s*[-:]?\s*\d{1,2}\b|\b(?:grade|graded)\s*[:=-]?\s*\d{1,2}\b/i;
  if (raw && gradeClaim.test(`${title}\n${baseDescription}`)) reasons.push('remove numeric grading claims from the public title and description for an ungraded coin');
  if (raw && ['Certification','Grade','Certification Number'].some(name => aspects[name]?.[0] && !['Uncertified','Ungraded','Not specified'].includes(aspects[name][0]))) reasons.push('ungraded coins cannot include certified grading specifics');
  const details = Object.entries(COIN_LABELS).filter(([key]) => !['gradingStatus','grade','gradingService','certNumber'].includes(key) && text(coin[key])).map(([key,label]) => `${label}: ${text(coin[key])}`);
  if (conditionPolicy) details.push(`eBay condition: ${conditionPolicy.conditionDescription}`);
  details.push(...descriptorLabels);
  if (!conditionPolicy?.conditionDescriptors?.length && !raw) details.push(...['grade','gradingService','certNumber'].filter(key => text(coin[key])).map(key => `${COIN_LABELS[key]}: ${coin[key]}`));
  if (raw && gradeClaim.test(details.join('\n'))) reasons.push('remove numeric grading claims from public coin notes for an ungraded coin');
  return { categoryId: metadata.category.id, categoryLabel: metadata.category.label, conditionId,
    condition: CONDITION_ENUMS[conditionId], conditionDescriptors, aspects, title,
    description: [baseDescription, `Coin details:\n${details.join('\n')}`].filter(Boolean).join('\n\n'),
    reasons: [...new Set(reasons)],
  };
}
export function seedCoinDescriptors(coin, metadata) {
  const policy = metadata?.policy?.itemConditions?.find(entry => String(entry.conditionId) === coinConditionId(coin, metadata));
  const result = {};
  if (coin.gradingStatus !== 'certified') return result;
  for (const descriptor of policy?.conditionDescriptors || []) {
    const id = String(descriptor.conditionDescriptorId);
    if (id === '5' && text(coin.certNumber)) result[id] = { additionalInfo: text(coin.certNumber) };
    if (id === '1' && text(coin.gradingService)) {
      const service = text(coin.gradingService).toLowerCase();
      const value = descriptor.conditionDescriptorValues?.find(entry => entry.conditionDescriptorValueName.toLowerCase() === service || entry.conditionDescriptorValueName.toLowerCase().includes(`(${service})`));
      if (value) result[id] = { values: [String(value.conditionDescriptorValueId)] };
    }
    if (id === '3') {
      const grade = text(coin.grade).toUpperCase().match(/^(MS|PR|PF|AU|EX|XF|EF|VF|VG|AG|FR|F|G|P)(?=\b|\d)/);
      const letter = grade && ({ MS:'MS/PR', PR:'MS/PR', PF:'MS/PR', EX:'EX/XF', XF:'EX/XF', EF:'EX/XF' }[grade[1]] || grade[1]);
      const value = descriptor.conditionDescriptorValues?.find(entry => entry.conditionDescriptorValueName === letter);
      if (value) result[id] = { values: [String(value.conditionDescriptorValueId)] };
    }
    if (id === '4') {
      const number = text(coin.grade).match(/(\d{1,2})\b/)?.[1];
      const value = descriptorValues(descriptor, result).find(entry => entry.conditionDescriptorValueName === number);
      if (value) result[id] = { values: [String(value.conditionDescriptorValueId)] };
    }
  }
  return result;
}
