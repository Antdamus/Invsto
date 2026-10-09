import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const source = await readFile(new URL('../tools/ebay-og-order-link-extension/content.js', import.meta.url), 'utf8');
const order = '12-15259-90368';
const confirmation = `This order is canceled\nItem ID: Item ID: 287632479257 287632479257\nOrder number Order number\n${order} ${order}\nBuyer Buyer\nfixture-buyer\nTotal refund\n$100.00`;
const names = ['isCancelConfirmationDetailsPage','isCancellationProofPage','isEbayCancellationsPage',
  'getEbayCancellationEntries','getVisiblePageLines','getValueAfterLabel','getCancelConfirmationMetadata',
  'setCancelProofButtonStatus','captureCancelConfirmationProof','injectCancelConfirmationProofButton',
  'injectCancellationPageButtons','sendCancellationBatchToOg'];
const functions = names.map(name => {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n  (?:async )?function /);
  return source.slice(start, end < 0 ? source.length : start + 1 + end);
}).join('\n');

function page(url, text = confirmation, response = {ok:true}) {
  const elements = new Map(), sent = [], alerts = [];
  const document = {
    title:'Cancel Details',
    getElementById:id=>elements.get(id),
    querySelectorAll:()=>[...elements.values()],
    createElement:()=>({style:{visibility:''},dataset:{},disabled:false,listeners:{},
      addEventListener(type,fn){this.listeners[type]=fn;},remove(){elements.delete(this.id);}}),
    body:{innerText:text,appendChild(element){elements.set(element.id,element);}},
  };
  const c=vm.createContext({URL,console,document,
    window:{location:new URL(url),setTimeout(){},alert:msg=>alerts.push(msg)},
    CANCEL_CONFIRM_CAPTURE_ID:'og-ebay-capture-cancel-confirmation',SEND_CANCELLATION_PANEL_ID:'og-ebay-cancellation-panel',
    CANCEL_PROOF_EXPORT_LABEL:'Export cancellation + screenshot to OG',
    normalizeOrderNumber:value=>String(value||'').match(/\b\d{2}-\d{5}-\d{5}\b/)?.[0]||'',
    assertExtensionContextActive(){},waitForNextPaint:async()=>{},
    chrome:{runtime:{sendMessage:async message=>{
      assert.ok([...elements.values()].every(e=>e.style.visibility==='hidden'),'hide extension controls during capture');
      sent.push(message);return response;
    }}},
  });
  vm.runInContext(functions,c);
  return {c,sent,alerts,elements};
}

for(const url of [
  'https://www.ebay.com/Cancel/Details?cancelId=12345',
  'https://www.ebay.com/Cancel/Details?itemId=287632479257&transId=10084216687526',
  `https://www.ebay.com/mesh/ord/details?orderid=${order}`,
])test(`the visible export button sends a screenshot, not a metadata-only import: ${url}`, async()=>{
  const p=page(url);
  p.c.injectCancellationPageButtons();
  p.c.injectCancelConfirmationProofButton();
  assert.equal(p.elements.size,1,'one cancellation control, no duplicate list exporter');
  const button=[...p.elements.values()][0];
  assert.equal(button.textContent,'Export cancellation + screenshot to OG');
  button.listeners.click({preventDefault(){},stopPropagation(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.sent.length,1);
  assert.equal(p.sent[0].type,'OG_EBAY_CAPTURE_CANCEL_CONFIRMATION');
  assert.equal(p.sent[0].payload.metadata.orderNumber,order);
  assert.equal(p.sent[0].payload.metadata.itemNumber,'287632479257');
  assert.equal(p.sent[0].payload.metadata.buyerUsername,'fixture-buyer');
  assert.equal(button.textContent,'Proof ready — finish in Invsto');
  assert.equal(button.style.visibility,'');
});

test('a stale list-export control on a single confirmation also uses the proof path',async()=>{
  const p=page(`https://www.ebay.com/mesh/ord/details?orderid=${order}`);
  await p.c.sendCancellationBatchToOg([{orderNumber:order}]);
  assert.equal(p.sent[0].type,'OG_EBAY_CAPTURE_CANCEL_CONFIRMATION');
});

for(const text of ['Buyer paid\nCancel order\n'+order,'This order is canceled\nOrder number\n',
  'This order is canceled\n11-11111-11111\n22-22222-22222'])test('normal, unidentified or ambiguous orders do not export proof: '+text.replaceAll('\n',' '),async()=>{
  const p=page(`https://www.ebay.com/mesh/ord/details?orderid=${order}`,text);
  await p.c.captureCancelConfirmationProof();
  assert.equal(p.sent.length,0);assert.equal(p.alerts.length,1);
});

test('a failed attachment is visible and never reports successful export',async()=>{
  const p=page('https://www.ebay.com/Cancel/Details?itemId=123&transId=456',confirmation,{ok:false,error:'Another cancellation is open in Invsto.'});
  p.c.injectCancelConfirmationProofButton();const button=[...p.elements.values()][0];
  await p.c.captureCancelConfirmationProof(button);
  assert.equal(button.textContent,'Proof capture failed');
  assert.equal(p.alerts[0],'Another cancellation is open in Invsto.');
  assert.equal(button.style.visibility,'');assert.equal(button.disabled,false);
});
