import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const source = await readFile(new URL('../pending-orders.js',import.meta.url),'utf8');
const links = await readFile(new URL('../bag-order-links.js',import.meta.url),'utf8');
const line = {id:'line-a',line_status:'pending',quantity:1,fulfilled_quantity:0,order:{status:'pending'}};

function fixture() {
  const elements = new Map();
  const element = () => ({value:'',textContent:'',innerHTML:'',classList:{add(){},remove(){},toggle(){}},replaceChildren(){},removeAttribute(){},toggleAttribute(){}});
  const context = vm.createContext({console,URLSearchParams,setTimeout,clearTimeout,window:{addEventListener(){}},document:{addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},querySelector(){return null;},body:{classList:{remove(){}}}}});
  vm.runInContext(links,context);vm.runInContext(source,context);
  vm.runInContext(`
    var statuses=[],selected=[],matchLoads=[],disposals=0;
    var lots=[{id:'lot-a',lot_code:'LIVE-AAAA',auction_number:'019',status:'open',live_sale_sessions:{store_id:'store-a'}},{id:'lot-b',lot_code:'LIVE-BBBB',auction_number:'020',status:'open'}];
    var matches=[],delayA=0,failItems=false,failMatches=false,deepLine=null;
    normalizeLine=line=>line;
    renderBuyerBundlePanel=renderSelectionSummary=renderItemResults=renderLocationResults=()=>{};
    renderLiveLotPanel=()=>{};
    applyOrderFilters=()=>renderLiveLotOrderMatches();
    selectOrderLine=id=>{selected.push(id);state.selectedLine=state.orders.find(l=>l.id===id);};
    setStatus=(text,type)=>statuses.push({text,type});
    window.bagOrderLinks.mount=({lot,onChange,initialSearch})=>{
      let disposed=false;
      return {dispose(){disposed=true;disposals++;},async load(){matchLoads.push({lot:lot.id,search:initialSearch});
        const data=failMatches?null:{matches,linked_line_id:matches.find(m=>m.linked)?.line.id};
        if(!disposed)onChange(data);return data;
      }};
    };
    var supabase={from(table){let filters=[];let max=Infinity;
      const result=async single=>{
        let rows=table==='live_sale_lots'?lots:table==='ebay_order_lines'?[deepLine].filter(Boolean):[];
        rows=rows.filter(row=>filters.every(([k,v])=>row[k]===v)).slice(0,max);
        if(table==='live_sale_lots'&&rows[0]?.id==='lot-a'&&delayA)await new Promise(r=>setTimeout(r,delayA));
        return table==='live_sale_lot_items'&&failItems?{error:{message:'Items unavailable'}}:{data:single?rows[0]||null:rows};
      };
      const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},order(){return q;},limit(n){max=n;return q;},maybeSingle(){return result(true);},then(fn){return result(false).then(fn);}};
      return q;
    }};
  `,context);
  return {context,run:code=>vm.runInContext(code,context),json:code=>JSON.parse(vm.runInContext(`JSON.stringify(${code})`,context))};
}

test('pending scanner finds suggestions for empty bags without a checkout store and only opens linked orders automatically',async()=>{
  const f=fixture();f.context.fixtureLine=line;
  f.run('matches=[{line:fixtureLine,score:220,linked:false}];');
  await f.run('loadLiveLotByScan("live-aaaa")');
  assert.equal(f.run('state.selectedLiveLot.id'),'lot-a');assert.equal(f.run('state.selectedLiveLotItems.length'),0);
  assert.equal(f.run('state.liveLotOrderMatches.length'),1);assert.deepEqual(f.json('selected'),[]);
  f.run('matches[0].linked=true;');await f.run('loadLiveLotByScan("LIVE-AAAA")');
  assert.deepEqual(f.json('selected'),['line-a']);
  assert.equal(f.run('state.orders[0].id'),'line-a');
});

test('repeated auction numbers and failed scans clear old bag and order selections',async()=>{
  const f=fixture();f.context.fixtureLine=line;
  f.run('matches=[{line:fixtureLine,linked:true}];');await f.run('loadLiveLotByScan("LIVE-AAAA")');
  f.run('lots[1].auction_number="019";');await f.run('loadLiveLotByScan("019")');
  assert.equal(f.run('state.selectedLiveLot'),null);assert.equal(f.run('state.selectedLine'),null);
  assert.match(f.run('statuses.at(-1).text'),/multiple bags/);
  f.run('failItems=true;');await f.run('loadLiveLotByScan("LIVE-BBBB")');
  assert.equal(f.run('state.selectedLiveLot'),null);assert.match(f.run('statuses.at(-1).text'),/Items unavailable/);
});

test('overlapping bag scans keep the newest result and clear invalid cross-store scans',async()=>{
  const f=fixture();f.run('delayA=100;');
  await Promise.all([f.run('loadLiveLotByScan("LIVE-AAAA")'),f.run('loadLiveLotByScan("LIVE-BBBB")')]);
  assert.equal(f.run('state.selectedLiveLot.id'),'lot-b');assert.equal(f.run('matchLoads.length'),1);
  f.run('state.checkoutStoreId="store-b";delayA=0;');await f.run('loadLiveLotByScan("LIVE-AAAA")');
  assert.equal(f.run('state.selectedLiveLot'),null);assert.match(f.run('statuses.at(-1).text'),/different live-sale store/);
});

test('bag deep links preserve manual search and fetch an explicit pending line outside suggestions',async()=>{
  const f=fixture();f.context.fixtureLine=line;
  f.run('deepLine=fixtureLine;');await f.run('loadLiveLotByScan("LIVE-AAAA",{search:"12-345-678"})');
  assert.equal(f.run('matchLoads[0].search'),'12-345-678');
  await f.run('openRequestedBagOrder(new URLSearchParams("bagLine=line-a"))');
  assert.deepEqual(f.json('selected'),['line-a']);
  f.run('deepLine={...fixtureLine,line_status:"fulfilled"};selected=[];');
  await f.run('openRequestedBagOrder(new URLSearchParams("bagLine=line-a"))');
  assert.deepEqual(f.json('selected'),[]);assert.match(f.run('statuses.at(-1).text'),/no longer pending/);
});

test('a connection lookup failure leaves contents visible but no stale suggested order',async()=>{
  const f=fixture();f.context.fixtureLine=line;
  f.run('matches=[{line:fixtureLine,linked:true}];');await f.run('loadLiveLotByScan("LIVE-AAAA")');
  f.run('failMatches=true;');await f.run('loadLiveLotByScan("LIVE-BBBB")');
  assert.equal(f.run('state.selectedLiveLot.id'),'lot-b');assert.equal(f.run('state.liveLotOrderMatches.length'),0);
  assert.equal(f.run('state.selectedLine'),null);assert.match(f.run('statuses.at(-1).text'),/could not be retrieved/);
});

test('refreshing a changed saved link clears the previously selected order',async()=>{
  const f=fixture();f.context.fixtureLine=line;
  f.run('matches=[{line:fixtureLine,linked:true}];');await f.run('loadLiveLotByScan("LIVE-AAAA")');
  assert.equal(f.run('state.selectedLine.id'),'line-a');
  f.run('matches=[{line:{...fixtureLine,id:"line-b"},linked:true}];');await f.run('state.liveBagConnectionsUI.load()');
  assert.equal(f.run('state.selectedLine'),null);assert.equal(f.run('state.liveBagConnection.linked_line_id'),'line-b');
});
