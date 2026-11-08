// Build a reviewable catalog import from observations of the visible eBay UI.
// No credentials, browser automation, or source-site requests are performed here.
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function prepareRows(events,observations){
 const metrics=new Map(observations.map(s=>[s.event_id,s]));
 const unique=new Map();
 for(const event of events){
  const cells=event.cells;
  if(!/Replay\s+Published/.test(cells[2]))continue;
  const match=cells[1].match(/^(\d+)\/(\d+)\/(\d{2})\s+(\d+):(\d+)(am|pm) (EDT|EST)$/);
  if(!match)throw Error('Unrecognized date for '+cells[4]);
  const [,mo,day,year,hour,minute,ampm,tz]=match;
  const h=Number(hour)%12+(ampm==='pm'?12:0);
  const starts_at=`20${year}-${mo.padStart(2,'0')}-${day.padStart(2,'0')}T${String(h).padStart(2,'0')}:${minute}:00${tz==='EDT'?'-04:00':'-05:00'}`;
  const observed=metrics.get(cells[4]);
  if(!observed)throw Error('Missing Insights observation for '+cells[4]);
  const get=name=>observed.metrics.find(m=>m.name.toLowerCase()===name.toLowerCase())?.value;
  const number=value=>value!=null&&/^\$?\d[\d,]*(?:\.\d+)?%?$/.test(value)?Number(value.replace(/[$,%]/g,'')):null;
  const duration=get('Length of stream');
  const seconds=duration&&/^\d+:\d{2}:\d{2}$/.test(duration)?duration.split(':').reduce((n,v)=>n*60+Number(v),0):null;
  const paid=number(get('PAID ITEMS')),gross=number(get('TOTAL SALES'));
  const insights={category:cells[3],status:seconds==null?'unavailable':'ready',
   sales_status:gross==null?'unavailable':'ready',source_url:event.href,checked_at:observed.checked_at,
   paid_items:paid,total_viewers:number(get('Total viewers')),peak_viewers:number(get('PEAK CONCURRENT VIEWERS')),
   studio_gross_including_tax_shipping:gross,studio_in_stream_sales:number(get('In-stream sales')),
   studio_average_sales_price:number(get('AVG SALES PRICE')),studio_in_stream_average_sales_price:number(get('In-stream avg sales price')),
   new_followers:number(get('NEW FOLLOWERS')),returning_viewers_percent:number(get('RETURNING VIEWERS')),
   conversion_percent:number(get('IN-STREAM CONVERSION')),
   purchasers:number(observed.metrics.find(m=>/^Purchased/i.test(m.name))?.value),metrics:observed.metrics};
  if(!cells[4]||!/^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(event.href))throw Error('Invalid event evidence');
  unique.set(cells[4],{event_id:cells[4],title:cells[0],starts_at,source:'ebay_live_studio',observed_at:observed.checked_at,
   airtime_seconds:seconds,airtime_source:seconds==null?null:'ebay_live_studio_insights',airtime_checked_at:observed.checked_at,
   airtime_provisional:Boolean(observed.provisional),insights});
 }
 return [...unique.values()];
}

export function importSql(rows){
 const payload=JSON.stringify(rows);
 if(payload.includes('$history$'))throw Error('Unsafe import delimiter');
 return `insert into public.weekly_ebay_show_catalog(event_id,title,starts_at,source,observed_at,airtime_seconds,airtime_source,airtime_checked_at,airtime_provisional,insights)
select event_id,title,starts_at,source,observed_at,airtime_seconds,airtime_source,airtime_checked_at,airtime_provisional,insights
from jsonb_to_recordset($history$${payload}$history$::jsonb) as x(event_id text,title text,starts_at timestamptz,source text,observed_at timestamptz,airtime_seconds integer,airtime_source text,airtime_checked_at timestamptz,airtime_provisional boolean,insights jsonb)
on conflict(event_id) do update set title=excluded.title,starts_at=excluded.starts_at,observed_at=excluded.observed_at,
airtime_seconds=coalesce(excluded.airtime_seconds,weekly_ebay_show_catalog.airtime_seconds),
airtime_source=coalesce(excluded.airtime_source,weekly_ebay_show_catalog.airtime_source),
airtime_checked_at=case when excluded.airtime_seconds is not null then excluded.airtime_checked_at else weekly_ebay_show_catalog.airtime_checked_at end,
airtime_provisional=case when excluded.airtime_seconds is not null then excluded.airtime_provisional else weekly_ebay_show_catalog.airtime_provisional end,
insights=excluded.insights;
`;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [eventsFile,insightsFile,output]=process.argv.slice(2);
 if(!output)throw Error('Usage: node tools/prepare-ebay-show-history.mjs events.json insights.json output.sql');
 const rows=prepareRows(JSON.parse(await readFile(eventsFile,'utf8')),JSON.parse(await readFile(insightsFile,'utf8')));
 await writeFile(output,importSql(rows));
 console.log(JSON.stringify({shows:rows.length,timed:rows.filter(r=>r.airtime_seconds!=null).length,sales:rows.filter(r=>r.insights.sales_status==='ready').length,
  earliest:rows.map(r=>r.starts_at).sort()[0],latest:rows.map(r=>r.starts_at).sort().at(-1)}));
}
