(function(root){
  'use strict';
  function localValue(iso, timeZone){
    if (!iso) return '';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
    }).formatToParts(new Date(iso)).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }
  function toISO(value, timeZone, original){
    if (!value) throw new Error('Enter a date and time.');
    // Keep the original seconds (and DST occurrence) when a field was not changed.
    if (original && localValue(original, timeZone) === value) return new Date(original).toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Enter a valid date and time.');
    const nominal = Date.parse(value + ':00Z');
    if (!Number.isFinite(nominal)) throw new Error('Enter a valid date and time.');
    const offsets = new Set();
    for (const hours of [-36,-12,0,12,36]){
      const ts = nominal + hours * 3600000;
      offsets.add(Date.parse(localValue(ts, timeZone) + ':00Z') - ts);
    }
    const matches = [...offsets].map(offset => nominal-offset).filter(ts => localValue(ts,timeZone) === value);
    if (!matches.length) throw new Error('That time does not exist in the store’s time zone (daylight saving change).');
    if (matches.length > 1) throw new Error('That time occurs twice during the daylight saving change. Choose an unambiguous time or have payroll review it.');
    return new Date(matches[0]).toISOString();
  }
  function label(code){
    return ({UNSCHEDULED_DAY:'Unscheduled day',EARLY_CLOCK_IN:'Early clock-in',LATE_CLOCK_IN:'Late clock-in',EARLY_CLOCK_OUT:'Early clock-out',LATE_CLOCK_OUT:'Late clock-out',ADMIN_TEST_LOCATION:'Admin test location'})[code] || String(code).replaceAll('_',' ').toLowerCase();
  }
  function geoError(code){
    return code === 1 ? 'Location access is blocked. Allow location for this website, then try again.'
      : code === 3 ? 'Location took too long. Move near a window and try again.'
      : 'Your location is unavailable. Check Location Services and your connection, then try again.';
  }
  const api = {localValue,toISO,label,geoError};
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TimeCorrection = api;
})(typeof window !== 'undefined' ? window : globalThis);
