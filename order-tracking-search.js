(function(root) {
  'use strict';
  function normalize(value) {
    return String(value || '').trim().replace(/^\][a-z0-9]{2}/i,'')
      .replace(/\u241d|\u00e2\u0090\u009d/g,'\x1d').replace(/[\s\x1d-]/g,'').toLowerCase();
  }
  function isScan(value) {
    const code=normalize(value);
    return code.length>=6 && code.length<=128 && /^(?:\d+|1z[a-z0-9]+)$/i.test(code);
  }
  function needle(value) {
    if (!isScan(value)) return '';
    const code=normalize(value);
    // Postal barcodes may prepend routing data. Twelve trailing characters
    // retain the existing history lookup behavior; shorter scans stay intact.
    return code.length>12 ? code.slice(-12) : code;
  }
  function matches(stored, scanned) {
    const part=needle(scanned);
    return Boolean(part && normalize(stored).includes(part));
  }
  function filter(fields, scanned) {
    const part=needle(scanned);
    // Only normalized letters/digits enter a PostgREST filter expression.
    return part ? fields.map(field=>`${field}.ilike.*${part}*`).join(',') : '';
  }
  const api={normalize,isScan,needle,matches,filter};
  if(typeof module!=='undefined') module.exports=api;
  root.OGTrackingSearch=api;
})(typeof window!=='undefined'?window:globalThis);
