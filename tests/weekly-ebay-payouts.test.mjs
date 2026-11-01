import assert from 'node:assert/strict';
import {test} from 'node:test';
import {payoutEntries} from '../supabase/functions/ebay-order-sync/weekly-payouts.ts';
test('a sent account transfer without orders is never attributed; keep only exact order transactions once',()=>{
 const sale={payoutId:'P',orderId:'12-12345-12345',transactionId:'S',transactionType:'SALE',bookingEntry:'CREDIT',amount:{value:'20.10',currency:'USD'}};
 const refund={...sale,transactionId:'R',transactionType:'REFUND',bookingEntry:'DEBIT',amount:{value:'-5.00',currency:'USD'}};
 assert.deepEqual(payoutEntries('P',[{...sale,orderId:null},sale,sale,refund,{...sale,transactionType:'PAYOUT'}]).map(x=>x.signed_amount),[20.1,-5]);
 assert.throws(()=>payoutEntries('P',[{...sale,payoutId:'OTHER'}]),/Unrelated/);
 assert.throws(()=>payoutEntries('P',[sale,{...sale,amount:{value:'99',currency:'USD'}}]),/Conflicting/);
 assert.throws(()=>payoutEntries('P',[{...sale,payoutId:null}]),/Missing/);
});
