import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {chromium} from '@playwright/test';
const file=p=>new URL('../'+p,import.meta.url);
test('action queue follows verified results, not job reservations or temporary marketplace delays',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create function auth.uid() returns uuid language sql as $$select '00000000-0000-4000-8000-000000000001'::uuid$$;
   create table employees(user_id uuid,active boolean,role text);insert into employees values(auth.uid(),true,'admin');
   create table ebay_report_browser_state(singleton boolean,lease_until timestamptz,completed timestamptz,note text);
   insert into ebay_report_browser_state values(true,null,now(),'18 order pages checked.');
   create table ebay_account_holds(singleton boolean,verified_at timestamptz,api_at timestamptz,api_cents bigint,ledger_cents bigint);
   insert into ebay_account_holds values(true,now(),now(),150,150);
   create table weekly_ebay_account_cash(month date primary key,movements jsonb,opening bigint,closing bigint);
   create table ebay_verified_statements(month date primary key,movements jsonb,opening bigint,closing bigint);
   create table weekly_ebay_claim_exports(month date,checked_at timestamptz);
   create table ebay_claim_report_checks(month date,note text,next_at timestamptz);
   create table ebay_orders(sale_date timestamptz);
   create table weekly_ebay_earnings_sync(connected_at timestamptz,last_error text);
   insert into weekly_ebay_earnings_sync values(null,'Awaiting eBay review');`);
  await db.exec(await readFile(file('supabase/migrations/20261101160000_ebay_report_manual_actions.sql'),'utf8'));
  const date='2024-01-01',actions=async()=>(await db.query('select ebay_report_manual_actions($1) a',[date])).rows[0].a;
  const kinds=async()=>(await actions()).map(a=>a.kind);
  assert.deepEqual(await kinds(),[]);
  await db.exec("update ebay_account_holds set verified_at=now()-interval '10 hours';");
  assert.equal((await actions())[0].reason,'stale');
  await db.exec("update ebay_report_browser_state set lease_until=now()+interval '5 minutes'");assert.deepEqual(await kinds(),[]);
  await db.exec("update ebay_report_browser_state set lease_until=null;update ebay_account_holds set verified_at=now()");
  assert.deepEqual(await kinds(),[]);
  await db.exec("update ebay_report_browser_state set completed=now(),note='Sign in to the ogjewelers Seller Hub account.'");
  assert.deepEqual(await kinds(),['seller']);
  await db.exec("update ebay_report_browser_state set completed=now(),note='0 order pages checked.'");
  assert.deepEqual(await kinds(),['seller'],'idle retry is not proof of renewed access');
  await db.exec("update ebay_report_browser_state set completed=now(),note='2 order pages checked.'");
  assert.deepEqual(await kinds(),[]);
  await db.exec("insert into ebay_orders values('2024-01-12');");
  assert.deepEqual(await kinds(),['statement']);
  await db.exec(`insert into weekly_ebay_account_cash values('2024-01-01','[{"label":"Gross claims","cents":-153}]',100,0);
   insert into ebay_claim_report_checks values('2024-01-01','Monthly transaction report is still being prepared.',now(),null);`);
  assert.deepEqual(await kinds(),[]);
  await db.exec("update ebay_claim_report_checks set note='Claim entries did not match the statement; prior verified details kept.'");
  assert.deepEqual(await kinds(),['claims']);
  await db.exec("update ebay_claim_report_checks set next_at=now()+interval '2 hours';insert into weekly_ebay_claim_exports values('2024-01-01',now());");
  assert.deepEqual(await kinds(),[]);
  await db.exec("insert into ebay_verified_statements values('2024-01-01','[]',90,0);");
  assert.deepEqual(await actions(),[{kind:'statement',reason:'mismatch',month:date}]);
  await db.exec("update weekly_ebay_account_cash set opening=90;update weekly_ebay_earnings_sync set connected_at=now(),last_error='eBay earnings API 429'");
  assert.deepEqual(await kinds(),[]);
  await db.exec("update weekly_ebay_earnings_sync set last_error='eBay earnings authorization required'");
  assert.deepEqual(await kinds(),['earnings']);
  assert.equal((await db.query("select has_function_privilege('anon','ebay_report_manual_actions(date)','execute') ok")).rows[0].ok,false);
  await db.exec("update employees set role='employee'");await assert.rejects(actions,/Active admin/);
 }finally{await db.close();}
});
test('a reminder is visible on the collapsed phone dashboard and opens the correct month and importer',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width:390,height:780}}),errors=[];
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  const html=await readFile(file('dashboard.html'),'utf8');
  await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]+>/gi,''));
  for(const f of ['dashboard.css','dashboard-workspace.css','weekly-marketplace-sales.css'])await page.addStyleTag({content:await readFile(file(f),'utf8')});
  for(const f of ['weekly-ebay-claims','weekly-ebay-cash','weekly-ebay-holds','weekly-ebay-actions','weekly-marketplace-sales'])
   await page.addScriptTag({content:await readFile(file(f+'.js'),'utf8')});
  await page.evaluate(()=>{
   window.queue=[{kind:'claims',month:'2024-01-01'}];window.loaded=[];
   window.WeeklyMarketplaceSales.init({rpc:async(name,p)=>{
    if(name==='ebay_report_manual_actions')return {data:window.queue};
    if(name==='get_weekly_sales_for_market'){window.loaded.push(p);
     return {data:{rows:[{market:'ebay',week:p._month,first_day:p._month,end_day:p._month,orders:0,settled_orders:0,net:0,held:0}],month:p._month,anchor:p._month,as_of:new Date().toISOString(),ebay_item_orders:[],ebay_account_payouts:[]}};}
   }});
  });
  const banner=page.locator('#ws-manual-actions');
  await banner.waitFor();assert.equal(await page.locator('#weekly-sales-report').evaluate(e=>e.open),false);
  assert.equal(await page.evaluate(()=>window.loaded.length),0,'no full financial report fetched just to check for reminders');
  await banner.getByRole('button',{name:'Open claims importer'}).click();
  await page.waitForFunction(()=>document.activeElement?.matches('#ws-ebay-cash .wcl-file'));
  assert.equal(await page.locator('#ws-month').inputValue(),'2024-01');
  assert.equal(await page.locator('.wc-sources').evaluate(e=>e.open),true);
  const bounds=await banner.evaluate(e=>({right:e.getBoundingClientRect().right,width:innerWidth}));
  assert.ok(bounds.right<=bounds.width+1,JSON.stringify(bounds));
  await page.evaluate(()=>{window.queue=[];document.querySelector('#ws-refresh').click();});
  await banner.waitFor({state:'hidden'});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
