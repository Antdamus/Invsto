import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const sandbox={URL,location:{href:'https://antdamus.github.io/Invsto/ebay-returns.html'}};
vm.runInNewContext(await readFile(new URL('../customer-issues.js',import.meta.url),'utf8'),sandbox);
const {caseHref,caseLinkLabel}=sandbox.OGCustomerIssues.testing;
const dispute={source_lane:'payment_dispute',ebay_return_id:'5010603112',order_number:'19-14964-36556'};
const expected='https://pmtdispute.ebay.com/dispute/5010603112';

test('payment dispute opens its dispute ID instead of the original order',()=>{
 assert.equal(caseHref(dispute),expected);
 assert.equal(caseLinkLabel(dispute,caseHref(dispute)),'Open eBay dispute');
});

test('the saved dispute ID takes priority over missing or stale imported links',()=>{
 for(const detailsUrl of ['', 'https://www.ebay.com/mesh/ord/details?orderid=19-14964-36556','https://www.ebay.com/itm/287499814123','https://pmtdispute.ebay.com/dispute/another-case']){
  assert.equal(caseHref({...dispute,raw_payload:{detailsUrl}}),expected);
  assert.equal(caseHref({...dispute,raw_payload:{apiExtractedDetails:{detailsUrl}}}),expected);
 }
 assert.equal(caseHref({...dispute,ebay_return_id:' 5010603112 '}),expected);
 assert.equal(caseHref({...dispute,ebay_return_id:'id/with?reserved#characters'}),'https://pmtdispute.ebay.com/dispute/id%2Fwith%3Freserved%23characters');
});

test('missing dispute IDs retain a safe fallback without promising a direct dispute link',()=>{
 const missing={...dispute,ebay_return_id:' '};
 assert.equal(caseHref(missing),'https://www.ebay.com/mesh/ord/details?orderid=19-14964-36556');
 assert.equal(caseLinkLabel(missing,caseHref(missing)),'Open eBay order / case');
 assert.equal(caseHref({...missing,order_number:null}), '');
 assert.equal(caseHref({...missing,raw_payload:{detailsUrl:expected}}),expected);
 assert.equal(caseLinkLabel(missing,expected),'Open eBay dispute');
 assert.equal(caseHref({...missing,raw_payload:{detailsUrl:'https://ebay.com.example.test/dispute/5010603112'}}),caseHref(missing));
});

test('returns and item-not-received requests keep their dedicated eBay destinations',()=>{
 assert.equal(caseHref({...dispute,source_lane:'return'}),'https://www.ebay.com/rtn/Return/ReturnsDetail?returnId=5010603112');
 assert.equal(caseHref({...dispute,source_lane:'inquiry'}),'https://www.ebay.com/res/ItemNotReceived/ViewRequest?id=5010603112');
 assert.equal(caseLinkLabel({source_lane:'return'},''),'Open eBay case');
 assert.equal(caseLinkLabel({source_lane:'inquiry'},''),'Open eBay case');
});
