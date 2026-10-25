import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
let browser;
before(async()=>{browser=await chromium.launch();});after(async()=>{await browser?.close();});
async function setup({admin=true}={}){
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const html=await readFile(new URL('../pending-orders.html',import.meta.url),'utf8');
 const panel=html.match(/<section id="ebay-auto-sync"[\s\S]*?<\/section>/)[0];
 await page.setContent(`<body style="background:#121513;color:#eee;font-family:Arial">${panel}<textarea id="draft">Unsaved packing note</textarea></body>`);
 await page.addStyleTag({content:await readFile(new URL('../ebay-auto-sync.css',import.meta.url),'utf8')});
 await page.evaluate(admin=>{
  window.calls=[];window.reloads=0;window.state={enabled:true,can_control:admin,syncing:false,last_synced_at:'2026-10-25T19:00:00Z',last_error:null};
  window.setInterval=callback=>{window.poll=callback;return 1;};
  window.db={rpc:async(name,args)=>{
   calls.push({name,args});if(name==='get_ebay_order_auto_sync_status')return {data:{...state}};
   if(args._action==='pause')state.enabled=false;if(args._action==='resume')state.enabled=true;if(args._action==='sync')state.syncing=true;
   return {};
  }};
 },admin);
 await page.addScriptTag({content:await readFile(new URL('../ebay-auto-sync.js',import.meta.url),'utf8')});
 await page.evaluate(()=>EbayAutoSync.start({db,refresh:()=>{reloads++;}}));return page;
}
test('automatic status and queued sync preserve edits; reload is explicit and admin pause/resume works on mobile',async()=>{
 const page=await setup();try{
  await expect(page.locator('#ebay-auto-sync-status')).toContainText('every 5 minutes');
  assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>poll());assert.equal(await page.evaluate(()=>reloads),0);await expect(page.locator('#draft')).toHaveValue('Unsaved packing note');
  await page.getByRole('button',{name:'Pause auto sync',exact:true}).click();await expect(page.locator('#ebay-auto-sync-status')).toContainText('paused');
  await expect(page.getByRole('button',{name:'Sync now',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Resume auto sync',exact:true}).click();
  await page.getByRole('button',{name:'Sync now',exact:true}).click();await expect(page.locator('#ebay-auto-sync-status')).toContainText('Sync in progress');
  assert.equal(await page.evaluate(()=>reloads),0);
  await page.getByRole('button',{name:'Check & reload orders',exact:true}).click();assert.equal(await page.evaluate(()=>reloads),1);
 }finally{await page.close();}
});
test('staff see sync failures without admin controls or automatic queue reloads',async()=>{
 const page=await setup({admin:false});try{
  await expect(page.locator('#ebay-auto-sync-toggle')).toBeHidden();
  await page.evaluate(()=>{state.last_error='eBay authorization needs to be reconnected by an administrator.';return poll();});
  await expect(page.locator('#ebay-auto-sync-status')).toContainText('needs to be reconnected');assert.equal(await page.evaluate(()=>reloads),0);
 }finally{await page.close();}
});
