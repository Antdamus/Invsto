import assert from 'node:assert/strict';
import {test} from 'node:test';
import M from '../live-sales-report-model.js';
const settings={rates:{gold_10:30,gold_14:42,silver:1.25},fee_percent:10,fee_fixed:1,shipping_per_sale:5};
test('profit categories separate material and type, include assumed silver and recognize earrings spellings',()=>{
  const titles=['Gold earrings 2g','Silver earings 3g','4 grams errings','14k ear-rings 2g','Seiko watch','WATCHES','wristwatch','timepiece','watch box','Gold plated ring 4g'];
  const attempts=titles.map((listing_title,i)=>({id:String(i),listing_title,buyer:'buyer',amount:100,payment_state:i===5?'waiting':'paid'}));
  const costs=Object.fromEntries(attempts.map(a=>[a.id,{mode:'manual',base_cost:20}]));
  const m=M.makeModel({attempts,costs,settings});
  assert.deepEqual(m.rows.slice(0,4).map(r=>r.categories.type),['earrings','earrings','earrings','earrings']);
  assert.deepEqual(m.rows.slice(4,8).map(r=>r.categories.type),['watches','watches','watches','watches']);
  assert.equal(m.rows[8].categories.type,'other');assert.equal(m.rows[9].categories.material,'other');
  assert.equal(m.rows[2].categories.material,'silver');assert.equal(m.rows[2].categories.assumedSilver,true);
  assert.equal(m.breakdowns.materials.find(g=>g.key==='silver').assumedSilver,1);
  for(const groups of Object.values(m.breakdowns)){
    assert.equal(groups.reduce((sum,g)=>sum+g.stats.paid.count,0),m.stats.paid.count);
    assert.equal(groups.reduce((sum,g)=>sum+g.stats.profit,0),m.stats.profit);
  }
  assert.equal(m.breakdowns.types.find(g=>g.key==='watches').stats.paid.count,3);
});
test('category profits retain partial coverage and material corrections override title assumptions',()=>{
  const attempts=[{id:'a',listing_title:'4g earrrings',buyer:'buyer',amount:100,payment_state:'paid'},{id:'b',listing_title:'Gold earrings',buyer:'buyer',amount:50,payment_state:'paid'}];
  const m=M.makeModel({attempts,settings,costs:{a:{mode:'metal',material:'gold',grams:2,purity:14}}});
  assert.equal(m.rows[0].categories.material,'gold');assert.equal(m.rows[0].categories.assumedSilver,false);
  const gold=m.breakdowns.materials.find(g=>g.key==='gold');assert.equal(gold.stats.missingCosts,1);assert.equal(M.buyerProfit(gold.stats,m.expensesKnown).partial,true);
});
test('title rules match literal phrases regardless of case and spaces; longest match wins',()=>{
  const titleRules=[{phrase:'watch',base_cost:10,enabled:true},{phrase:'watch box',base_cost:25,enabled:true},{phrase:'[special]',base_cost:0,enabled:true}];
  const cost=M.costFor({listing_title:'#22 WATCH   BOX / leather'},{},{...settings,titleRules});
  assert.equal(cost.base,2500);assert.equal(cost.rule.phrase,'watch box');assert.match(cost.source,/Title rule/);
  assert.equal(M.costFor({listing_title:'watch gold 2g'},{},{...settings,titleRules}).base,1000);
  assert.equal(M.costFor({listing_title:'[SPECIAL]'},{},{titleRules}).base,0);
  assert.equal(M.costFor({listing_title:'special'},{},{titleRules}).base,null);
  assert.equal(M.costFor({listing_title:'watch box'},{},{titleRules:titleRules.map(r=>({...r,enabled:false}))}).base,null);
  assert.equal(M.costFor({listing_title:'Silver 2g'},{},{...settings,titleRules}).base,250);
});
test('manual and corrected costs beat rules; conflicting equally specific phrases stay unknown',()=>{
  const titleRules=[{phrase:'ring',base_cost:20,enabled:true},{phrase:'gold',base_cost:30,enabled:true}];
  const a={listing_title:'gold ring 2g'};
  const conflict=M.costFor(a,{},{...settings,titleRules});assert.equal(conflict.base,null);assert.equal(conflict.rule.conflict,true);
  assert.equal(M.costFor(a,{mode:'manual',base_cost:0},{...settings,titleRules}).base,0);
  assert.equal(M.costFor(a,{mode:'metal',material:'silver',grams:2},{...settings,titleRules}).base,250);
  assert.equal(M.costFor(a,{},{...settings,titleRules:[titleRules[0],{...titleRules[1],base_cost:20}]}).base,2000);
  assert.equal(M.costFor(a,{},{...settings,titleRules:[{...titleRules[0],base_cost:null}]}).base,6000);
});
test('global title rules recalculate buyer profit and losses but never count unpaid purchases',()=>{
  const payload={global_material_costs:{rates:{silver:5.8},title_cost_rules:[{phrase:'watch',base_cost:120,enabled:true}]},attempts:[
    {id:'paid',listing_title:'Vintage watch',buyer:'buyer',payment_state:'paid',amount:100},
    {id:'waiting',listing_title:'Vintage watch',buyer:'buyer',payment_state:'waiting',amount:200}
  ]};
  const model=M.makeModel(payload);assert.equal(model.rows[0].cost.base,12000);assert.equal(model.stats.margin,-2000);assert.equal(model.stats.lossItems,1);assert.equal(model.stats.pricedPaid,1);assert.equal(model.rows[1].margin,null);
  assert.equal(M.makeModel({...payload,costs:{paid:{mode:'manual',base_cost:50}}}).stats.margin,5000);
});
test('title parser uses explicit purity or the requested 10K assumption',()=>{
  assert.deepEqual(M.parseTitle('Gold necklace 12.5 g'),{material:'gold',grams:12.5,purity:10,assumed:true,assumption:'10K assumed',ambiguous:false,note:'10K gold assumed because purity is not specified.'});
  assert.equal(M.costFor({listing_title:'14kt gold 2 grams'}, {},settings).base,8400);
  assert.equal(M.costFor({listing_title:'925 sterling silver 10g'}, {},settings).base,1250);
  assert.equal(M.costFor({listing_title:'Gold 5gr'}, {},settings).base,15000);
});
test('ambiguous, plated, missing and invalid title information never becomes a zero cost',()=>{
  for(const title of ['Watch','Gold ring','Gold 5-10g','Gold 5 to 10g','Gold 5,5g','Gold 1/2 grams','Gold 5g silver 3g','Gold plated 5g','Gold colored 5g','Gold filled 5g','14k 18k 5g','30k gold 5g','Gold 5g + 2g','Gold 5g + 5g','Gold -5g','Gold .5g']){
    assert.equal(M.costFor({listing_title:title},{},settings).base,null,title);
  }
  assert.equal(M.costFor({listing_title:'18k gold 2g'},{},settings).base,null);
});

test('a clear gram weight without a material defaults to labeled sterling silver 925',()=>{
  for(const title of ['10g bracelet','10 grams','JEWELRY ITEM 10 GRAMS - AS SEEN ON SCREEN','10gr chain','10 grs pendant']){
    const cost=M.costFor({listing_title:title},{},{rates:{silver:5.8,gold_10:78}});
    assert.equal(cost.base,5800,title);assert.equal(cost.parsed.material,'silver');assert.equal(cost.parsed.purity,925);
    assert.equal(cost.parsed.assumption,'Silver 925 assumed');assert.match(cost.source,/sterling silver 925 \(Silver 925 assumed\)/);
    assert.match(cost.parsed.note,/material is not specified/);
  }
  const title='#008 - JEWELRY ITEM 4 Grams 24inches Diamond Cut Chain- AS SEEN ON SCREEN';
  const payload={attempts:[{id:'weight',buyer:'a',listing_title:title,amount:44,payment_state:'paid'}],global_material_costs:{rates:{silver:5.8}}};
  const m=M.makeModel(payload);assert.equal(m.rows[0].cost.base,2320);assert.equal(m.stats.missingCosts,0);
  assert.equal(M.buyerProfit(m.customers[0].stats,m.expensesKnown).amount,2080);
  assert.equal(M.makeModel({...payload,settings:{rates:{silver:6}}}).rows[0].cost.base,2400);
  assert.equal(M.makeModel({...payload,costs:{weight:{mode:'manual',base_cost:0}}}).rows[0].cost.base,0);
  assert.equal(M.costFor({listing_title:title},{mode:'metal',material:'gold',purity:14,grams:4},{rates:{gold_14:99}}).base,39600);
});

test('the silver default does not replace explicit materials, ambiguous weights or unsupported purities',()=>{
  const rates={silver:5.8,gold_10:78,gold_14:99};
  for(const title of ['Platinum 4g','Stainless steel 4 grams','Copper 4g','Brass 4g','Titanium 4g','Leather 4g','Silver and steel 4g','4g plated bracelet','4-5g bracelet','4 to 5 grams','4g + 5g','4g + 4g','4,5g','1/2 grams','-4g','.5g','0 grams','Bracelet','950 silver 4g','999 bracelet 4g']){
    assert.equal(M.costFor({listing_title:title},{},{rates}).base,null,title);
  }
  assert.equal(M.costFor({listing_title:'Gold 4g'},{},{rates}).base,31200);
  assert.equal(M.costFor({listing_title:'14k 4g'},{},{rates}).base,39600);
  assert.equal(M.parseTitle('925 silver 4g').assumed,false);
  assert.equal(M.costFor({listing_title:'4g bracelet'},{},{rates:{}}).base,null);
});
test('manual total costs, including explicit zero, take priority and metal corrections are explicit',()=>{
  assert.equal(M.costFor({listing_title:'Gold 5g'},{mode:'manual',base_cost:0},settings).base,0);
  assert.equal(M.costFor({listing_title:'Gold 5g'},{mode:'manual',base_cost:37.19},settings).base,3719);
  assert.equal(M.costFor({listing_title:'Unknown'},{mode:'metal',material:'silver',grams:2.5},settings).base,313);
});
test('paid totals exclude held, merged, resolved and unpaid attempts; margin shows cost coverage',()=>{
  const attempts=[{id:'1',buyer:'Alice',amount:100,payment_state:'paid',listing_title:'Gold 2g'},
    {id:'2',buyer:'alice',amount:50,payment_state:'waiting'},{id:'3',buyer:'bob',amount:200,payment_state:'failed'},
    {id:'4',buyer:'bob',amount:70,payment_state:'paid',payment_hold:true},{id:'5',buyer:'bob',amount:300,payment_state:'paid',resolved_at:'2026-10-01'},
    {id:'6',buyer:'alice',amount:100,payment_state:'paid',merged_into:'1'},{id:'7',buyer:'alice',amount:20,payment_state:'paid'}];
  const model=M.makeModel({attempts,settings,evidence:{'1':{order:{buyer_name:'Alice Example'},line:{quantity:2}}}});
  assert.equal(model.rows.length,6);assert.equal(model.customers.length,2);assert.equal(model.customers[0].name,'Alice Example');
  assert.deepEqual(model.stats.paid,{count:2,amount:12000});assert.equal(model.stats.expectedItems,3);
  assert.equal(model.stats.missingCosts,1);assert.equal(model.stats.pricedPaid,1);assert.equal(model.stats.base,6000);assert.equal(model.stats.margin,4000);assert.equal(model.stats.profit,2400);
});
test('blank expenses stay unknown, zero is known, unknown amount is not inferred',()=>{
  const a={id:'1',buyer:'A',amount:10,payment_state:'paid'},costs={'1':{mode:'manual',base_cost:2}};
  assert.equal(M.makeModel({attempts:[a],costs}).rows[0].profit,null);
  const m=M.makeModel({attempts:[a,{...a,id:'2',amount:null}],costs,settings:{fee_percent:0,fee_fixed:0,shipping_per_sale:0}});
  assert.equal(m.rows[0].profit,800);assert.equal(m.stats.missingAmounts,1);assert.equal(m.stats.paid.amount,1000);
});
test('payment holds do not disguise recorded failures or pending payments',()=>{
  const m=M.makeModel({attempts:[{id:'1',amount:10,payment_state:'failed',payment_hold:true},{id:'2',amount:20,payment_state:'waiting',payment_hold:true},{id:'3',amount:30,payment_state:'paid',payment_hold:true}]});
  assert.deepEqual(m.stats.failed,{count:1,amount:1000});assert.deepEqual(m.stats.waiting,{count:1,amount:2000});assert.deepEqual(m.stats.paid,{count:0,amount:0});assert.deepEqual(m.stats.review,{count:1,amount:3000});
});
test('buyer anchors are safe and system links use real order numbers and correct page',()=>{
  const m=M.makeModel({attempts:[{id:'1',buyer:'A % é',amount:10,payment_state:'paid'}],evidence:{'1':{order:{id:'uuid',order_number:'01-12345-12345',status:'fulfilled'},line:{id:'line'}}}});
  assert.match(m.customers[0].key,/^buyer-[a-f0-9-]+$/);
  const url=new URL(m.rows[0].links.find(([label])=>label==='System order')[1]);assert.equal(url.pathname,'/Invsto/ebay-order-history.html');assert.equal(url.searchParams.get('focusOrder'),'01-12345-12345');
});


test('individual losses remain visible despite a profitable buyer total and sort buyers by loss',()=>{
  const attempts=[{id:'win',buyer:'offset.buyer',amount:300,payment_state:'paid'},
    {id:'loss',buyer:'offset.buyer',amount:50,payment_state:'paid'},
    {id:'bigger',buyer:'z.biggest',amount:10,payment_state:'paid'},
    {id:'even',buyer:'a.break-even',amount:100,payment_state:'paid'}];
  const costs=Object.fromEntries(attempts.map(a=>[a.id,{mode:'manual',base_cost:100}]));
  const m=M.makeModel({attempts,costs});
  assert.deepEqual(m.customers.map(b=>b.username),['z.biggest','offset.buyer','a.break-even']);
  assert.equal(m.customers[1].stats.margin,15000);assert.equal(m.customers[1].stats.lossItems,1);assert.equal(m.customers[1].stats.lossAmount,5000);
  assert.equal(m.stats.lossItems,2);assert.equal(m.stats.lossAmount,14000);assert.equal(m.rows.find(r=>r.id==='even').loss,0);
  assert.equal(m.lossBasis,'before fees and shipping');
});

test('loss assessment uses complete expense estimates but excludes unassessed and unpaid items',()=>{
  const attempts=['paid','waiting','failed','cancelled'].map((payment_state,i)=>({id:String(i),buyer:'buyer',amount:100,payment_state}));
  attempts.push({id:'held',buyer:'buyer',amount:100,payment_state:'paid',payment_hold:true},{id:'unknown-cost',buyer:'buyer',amount:100,payment_state:'paid'},{id:'unknown-amount',buyer:'buyer',amount:null,payment_state:'paid'},{id:'resolved',buyer:'buyer',amount:100,payment_state:'paid',resolved_at:'2026-10-29'});
  const costs=Object.fromEntries(attempts.filter(a=>a.id!=='unknown-cost').map(a=>[a.id,{mode:'manual',base_cost:95}]));
  const m=M.makeModel({attempts,costs,settings:{fee_percent:10,fee_fixed:1,shipping_per_sale:5}});
  assert.equal(m.rows[0].margin,500);assert.equal(m.rows[0].loss,1100);assert.equal(m.stats.lossItems,1);assert.equal(m.stats.lossAmount,1100);assert.equal(m.lossBasis,'after estimated fees and shipping');
  assert.ok(m.rows.slice(1).every(r=>r.loss===0));
  const incomplete=M.makeModel({attempts,costs,settings:{fee_percent:10,fee_fixed:null,shipping_per_sale:5}});assert.equal(incomplete.stats.lossItems,0);assert.equal(incomplete.lossBasis,'before fees and shipping');
  const corrected=M.makeModel({attempts,costs:{...costs,'0':{mode:'manual',base_cost:0}},settings:{fee_percent:10,fee_fixed:1,shipping_per_sale:5}});assert.equal(corrected.stats.lossItems,0);
});

test('buyer profit reports partial coverage without treating missing costs or sale amounts as zero',()=>{
  const attempts=[{id:'known',buyer:'a',amount:100,payment_state:'paid'},
    {id:'cost-missing',buyer:'a',amount:200,payment_state:'paid'},
    {id:'amount-missing',buyer:'a',amount:null,payment_state:'paid'},
    {id:'pending',buyer:'a',amount:300,payment_state:'waiting'},
    {id:'held',buyer:'a',amount:100,payment_state:'paid',payment_hold:true},
    {id:'resolved',buyer:'a',amount:100,payment_state:'paid',resolved_at:'2026-10-29'}];
  const costs={known:{mode:'manual',base_cost:40},'amount-missing':{mode:'manual',base_cost:30}};
  const model=M.makeModel({attempts,costs,settings});
  const p=M.buyerProfit(model.customers[0].stats,model.expensesKnown);
  assert.equal(p.amount,4400);assert.equal(p.status,'Partial');assert.equal(p.partial,true);
  assert.equal(p.coverage,'1 of 3 paid purchases included');assert.equal(p.missing,'1 missing base cost · 1 missing sale amount');
  assert.equal(p.label,'Estimated profit');assert.equal(p.basis,'After estimated fees and shipping');
  const before=M.makeModel({attempts,costs});
  assert.equal(M.buyerProfit(before.stats,before.expensesKnown).amount,6000);
  assert.equal(M.buyerProfit(before.stats,before.expensesKnown).label,'Profit before expenses');
  const fixed=M.makeModel({attempts:attempts.map(a=>a.id==='amount-missing'?{...a,amount:50}:a),costs:{...costs,'cost-missing':{mode:'manual',base_cost:100}},settings});
  const complete=M.buyerProfit(fixed.stats,fixed.expensesKnown);
  assert.equal(complete.amount,12700);assert.equal(complete.status,'Complete');assert.equal(complete.missing,'');
});

test('buyer profit distinguishes unavailable, no paid purchases, known zero and a net loss',()=>{
  const a={id:'one',buyer:'a',amount:10,payment_state:'paid'};
  const profit=(attempts,costs={})=>{const m=M.makeModel({attempts,costs});return M.buyerProfit(m.stats,m.expensesKnown);};
  assert.equal(profit([a]).amount,null);assert.equal(profit([a]).status,'Unavailable');
  assert.equal(profit([{...a,amount:null}],{one:{mode:'manual',base_cost:0}}).amount,null);
  assert.equal(profit([{...a,payment_state:'failed'}]).status,'No paid purchases');
  assert.equal(profit([]).amount,null);
  assert.equal(profit([a],{one:{mode:'manual',base_cost:10}}).amount,0);
  assert.equal(profit([a],{one:{mode:'manual',base_cost:0}}).amount,1000);
  assert.equal(profit([a],{one:{mode:'manual',base_cost:20}}).amount,-1000);
});
