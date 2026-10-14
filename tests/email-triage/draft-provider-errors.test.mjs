import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {test} from 'node:test';

const source=await readFile(new URL('../../supabase/functions/ebay-conversation-draft/index.ts',import.meta.url),'utf8');
function fixture(status,code,type){
  const requests=[];
  const scope=vm.createContext({Response,AbortController,DOMException,setTimeout,clearTimeout,
    Deno:{env:{get:name=>name==='OPENAI_API_KEY'?'test-key':undefined}},
    fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({error:{code,type,message:'private provider text sk-do-not-show'}}),{status});},
  });
  const body=source.replace(/^import[\s\S]*?from\s+"[^"]+";\s*/gm,'').slice(0,source.replace(/^import[\s\S]*?from\s+"[^"]+";\s*/gm,'').lastIndexOf('serve(async'));
  vm.runInContext(stripTypeScriptTypes(body,{mode:'transform'}),scope);
  return {scope,requests};
}

for(const code of ['insufficient_quota','credit_balance_exhausted','project_spend_limit_exceeded','organization_spend_limit_exceeded','organization_usage_limit_exceeded']){
  test(`drafting reports ${code} without treating billing as temporary throttling`,async()=>{
    const f=fixture(429,code,'insufficient_quota');
    await assert.rejects(vm.runInContext('callOpenAI({operator_draft:"Sample"},"Copy edit this sample","gpt-4.1-mini")',f.scope),error=>{
      assert.equal(error.code,'openai_quota_exceeded');assert.equal(error.transient,false);
      assert.equal(error.details.provider_code,code);assert.match(error.message,/credit or spending limit/);
      assert.doesNotMatch(JSON.stringify(error),/sk-do-not-show|private provider/);return true;
    });
    assert.equal(f.requests.length,1);
  });
}

for(const [status,code,expected,transient] of [[429,'rate_limit_exceeded','openai_rate_limited',true],[401,'invalid_api_key','openai_authentication_failed',false],[403,null,'openai_authentication_failed',false],[400,'unsupported_parameter','openai_request_failed',false],[503,'server_is_overloaded','openai_request_failed',true]]){
  test(`translation reports ${status}/${code} safely through the same connection`,async()=>{
    const f=fixture(status,code);
    await assert.rejects(vm.runInContext('callOpenAITranslation("Hello")',f.scope),error=>{
      assert.equal(error.code,expected);assert.equal(error.transient,transient);
      assert.doesNotMatch(JSON.stringify(error),/sk-do-not-show|private provider/);return true;
    });
    assert.equal(f.requests.length,1);
  });
}

test('unrecognized provider codes are never returned to the browser',async()=>{
  const f=fixture(400,'sk-private-credential');
  await assert.rejects(vm.runInContext('callOpenAITranslation("Hello")',f.scope),error=>error.details.provider_code===null);
});

test('the reply editor displays the actionable AI failure and leaves send errors intact',async()=>{
  const js=await readFile(new URL('../../email-triage.js',import.meta.url),'utf8');
  const fn=js.slice(js.indexOf('  function ebayDraftActionErrorMessage('),js.indexOf('  function renderEbayDraftFactRows('));
  const c=vm.createContext({});vm.runInContext(fn,c);
  assert.equal(vm.runInContext('ebayDraftActionErrorMessage({code:"openai_quota_exceeded",detail:"Billing action needed. Your message is unchanged."},"improve")',c),'Billing action needed. Your message is unchanged.');
  assert.match(vm.runInContext('ebayDraftActionErrorMessage({code:"provider_rejected"},"send")',c),/verify the eBay conversation/);
});
