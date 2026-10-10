(() => {
  'use strict';
  function parseMoney(value,{optional=false,positive=false}={}) {
    const text=String(value ?? '').trim();
    if(!text && optional)return null;
    if(!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?|\.\d{1,2})$/.test(text))throw new Error('Use a number with at most two decimal places.');
    const number=Number(text.replace(/,/g,''));
    if(!Number.isFinite(number) || number>9999999999.99 || (positive && number<=0))throw new Error(positive?'Retail price must be greater than zero.':'Enter a valid amount.');
    return number;
  }
  function prices(cost,retail,minimum) {
    const result={cost:parseMoney(cost),retail:parseMoney(retail,{positive:true}),minimum:parseMoney(minimum,{optional:true})};
    if(result.minimum!==null && result.minimum>result.retail)throw new Error('Minimum selling price cannot be higher than retail.');
    return result;
  }
  window.InventoryPricing={parseMoney,prices};
})();
