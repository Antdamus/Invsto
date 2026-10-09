import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {test} from 'node:test';

const source=await readFile(new URL('../supabase/functions/ebay-oauth-callback/index.ts',import.meta.url),'utf8');
const base='https://api.ebay.com/oauth/api_scope';
async function consent(overrides={}) {
 let handler;
 const env={EBAY_CLIENT_ID:'test-client',EBAY_CLIENT_SECRET:'test-secret',EBAY_OAUTH_RUNAME:'test-redirect',...overrides};
 const sandbox={URL,URLSearchParams,Response,Request,Headers,Set,Deno:{env:{get:key=>env[key]},serve:fn=>handler=fn},fetch:()=>{throw Error('A consent page must not exchange or change credentials');}};
 vm.runInNewContext(stripTypeScriptTypes(source),sandbox);
 const response=await handler(new Request('https://example.test/ebay-oauth-callback'));
 const html=await response.text();
 const match=html.match(/href="([^"]+)"/);
 return new URL(match[1].replaceAll('&amp;','&'));
}
test('reconnect keeps every existing default permission and adds payment disputes',async()=>{
 const url=await consent();
 const scopes=new Set(url.searchParams.get('scope').split(' '));
 for(const scope of ['', '/sell.inventory','/sell.account.readonly','/sell.fulfillment.readonly','/sell.fulfillment','/sell.finances','/commerce.message','/commerce.notification.subscription','/sell.payment.dispute']) assert.ok(scopes.has(base+scope),scope);
 assert.equal(url.origin,'https://auth.ebay.com');assert.equal(url.searchParams.get('redirect_uri'),'test-redirect');assert.equal(url.searchParams.get('response_type'),'code');
});
test('configured scopes survive reconnect and the dispute permission is not duplicated',async()=>{
 const url=await consent({EBAY_OAUTH_SCOPES:`${base}   ${base}/commerce.message\n${base}/sell.payment.dispute ${base}/sell.custom`});
 const scopes=url.searchParams.get('scope').split(' ');
 assert.equal(scopes.length,new Set(scopes).size);
 for(const suffix of ['/commerce.message','/sell.fulfillment','/sell.finances','/commerce.notification.subscription','/sell.payment.dispute','/sell.custom']) assert.ok(scopes.includes(base+suffix),suffix);
});
test('sandbox authorization stays in sandbox',async()=>{
 assert.equal((await consent({EBAY_ENV:'sandbox'})).origin,'https://auth.sandbox.ebay.com');
});
