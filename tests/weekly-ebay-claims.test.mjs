import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {chromium} from '@playwright/test';
import '../weekly-ebay-claims.js';
const file=s=>fileURLToPath(new URL('../'+s,import.meta.url));
const month='2026-10-01',id='12-12345-67890',posted=(v,over={})=>({id,day:'2026-10-21',kind:'Case',ref:'123456',gross:v,net:v,fees:0,...over});
test('an eBay transaction export retains signed Claim entries and rejects partial date ranges',()=>{
 const header='Transaction creation date,Type,Order number,Reference ID,Gross transaction amount,Transaction currency,Net amount,Payout currency,Final Value Fee - fixed,Final Value Fee - variable,Regulatory operating fee,"Very high ""item not as described"" fee",Below standard performance fee,International fee,Deposit processing fee,Description';
 const csv=['Seller,ogjewelers','Start date,Oct-01-2026 00:00:00 AM PDT','End date,Oct-31-2026 23:59:59 PM PDT','This report includes transaction type,"claim, order, refund"',header,
 '"Oct 20, 2026",Refund,'+id+',--,-300,USD,-300,USD,0,0,0,0,0,0,0,"Refund, not a claim"',
 '"Oct 21, 2026",Claim,'+id+',Case ID 123456,-100.00,USD,-95,USD,0,5,0,0,0,0,0,"Note\nwith a newline"',
 '"Oct 22, 2026",Claim,'+id+',--,20,USD,20,USD,--,--,--,--,--,--,--,'].join('\r\n');
 assert.deepEqual(WeeklyEbayClaims.parseExport(csv,'2026-10'),[posted(-10000,{net:-9500,fees:500}),posted(2000,{day:'2026-10-22',kind:null,ref:null})]);
 assert.throws(()=>WeeklyEbayClaims.parseExport(csv.replace('Oct-31','Oct-30'),'2026-10'),/entire selected month/);
 assert.throws(()=>WeeklyEbayClaims.parseExport(csv.replace('Seller,ogjewelers','Seller,other'),'2026-10'),/OG Jewelers/);
});
test('claims must reconcile; a case for a different order or a credit without a reference cannot supply a cause',async()=>{
 const db=new PGlite();
 try{
 await db.exec("create schema auth;create role anon;create role authenticated;create role service_role;create function auth.uid() returns uuid language sql as $$select '00000000-0000-0000-0000-000000000001'::uuid$$;create table employees(user_id uuid,active bool,role text);insert into employees values(auth.uid(),true,'admin');create table ebay_orders(id uuid,order_number text,raw_payload jsonb);create table ebay_order_lines(order_id uuid,item_title text);create table weekly_ebay_sale_updates(order_number text,changes jsonb);create table ebay_return_cases(id uuid default gen_random_uuid(),order_number text,source_lane text,ebay_return_id text,raw_payload jsonb,synced_at timestamptz,return_reason text,opened_at timestamptz,item_title text,ebay_status text);create table weekly_ebay_account_cash(month date,source text,movements jsonb);create function get_weekly_sales_for_market(m date,_market text) returns jsonb language sql as $$select jsonb_build_object('ebay_cash_statement',null)$$;");
 const exec=async(s,args=[])=>(await db.query(s,args)).rows;
 await db.exec(await readFile(file('supabase/migrations/20261101114000_weekly_ebay_claims.sql'),'utf8'));
 await exec("insert into weekly_ebay_account_cash values ($1,'eBay Seller Hub financial overview',$2)",[month,JSON.stringify([{label:'Gross claims',cents:-8000}])]);
 await exec("insert into ebay_return_cases(order_number,source_lane,ebay_return_id,raw_payload) values ($1,'case','123456',$2)",['33-12345-12345',JSON.stringify({ebayDetail:{caseId:'123456',caseType:'RETURN',sellerOutcome:'LOSE'}})]);
 const rows=[posted(-10000,{net:-9500,fees:500}),posted(2000,{ref:null,kind:null})],save=r=>exec("select save_ebay_claim_export($1,$2)",[month,JSON.stringify(r)]);
 await save(rows);await save(rows);
 let [{v}]=await exec("select get_weekly_sales_for_market($1,'ebay')->'ebay_claims' v",[month]);
 assert.equal(v.rows.length,2);assert.equal(v.rows[0].other_order,'33-12345-12345');assert.equal(v.rows[0].issue,null);assert.equal(v.rows[1].other_order,null);
 assert.deepEqual(await exec("select get_weekly_sales_for_market($1,'whatnot')->'ebay_claims' v",[month]),[{v:null}]);
 await assert.rejects(save(rows.slice(1)),/do not match/);
 await exec("update weekly_ebay_account_cash set source='eBay monthly financial statement',movements=$1",[JSON.stringify([{label:'Claims',cents:-7500}])]);await save(rows);
 await db.exec('delete from employees');await assert.rejects(save(rows),/admin/);
 }finally{await db.close();}
});
test('from the statement to filtered claim postings on a phone, preserving the filter on refresh',async()=>{
 const browser=await chromium.launch();
 try{
 const page=await browser.newPage({viewport:{width:390,height:800}});await page.setContent('<section id="cash" class="wc-panel"></section>');
 for(const js of ['weekly-ebay-items.js','weekly-ebay-claims.js','weekly-ebay-cash.js'])await page.addScriptTag({path:file(js)});
 await page.addStyleTag({path:file('weekly-marketplace-sales.css')});
 const data={month,rows:[],ebay_item_orders:[],ebay_claims:{rows:[posted(-10000,{issue:'c1',type:'RETURN',reason:'NOT_AS_DESCRIBED',status:'CLOSED',seller:'LOSE',net:-9500,fees:500}),posted(2000,{kind:null,ref:null})]},ebay_cash_statement:{opening:10000,closing:2000,source:'eBay Seller Hub financial overview',movements:[{label:'Gross claims',cents:-8000}]}};
 const render=()=>page.evaluate(d=>WeeklyEbayCash.update(document.querySelector('#cash'),d),data);await render();
 assert.deepEqual(await page.locator('.wcl-totals b').allTextContents(),['-$100.00','+$20.00','-$80.00']);
 await page.locator('.wc-ledger>summary').click();await page.locator('[data-show-claims]').click();
 await page.locator('[data-filter=credit]').click();assert.equal(await page.locator('.wcl-list li:visible').count(),1);
 await render();assert.equal(await page.locator('.wcl-list li:visible').count(),1);assert.match(await page.locator('.wcl-list li:visible').innerText(),/without a case number/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 data.ebay_claims.rows.pop();await render();assert.match(await page.locator('.wcl-panel').innerText(),/no longer match/);
 }finally{await browser.close();}
});
