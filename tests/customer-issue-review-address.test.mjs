import {test} from 'node:test';
import assert from 'node:assert/strict';
import M from '../customer-issue-review-model.js';

const ship=(street,name='Order recipient')=>({fullName:name,email:'private@example.test',primaryPhone:{phoneNumber:'555-0100'},contactAddress:{addressLine1:street,addressLine2:'Unit 4',city:'Example City',stateOrProvince:'FL',postalCode:'33000',countryCode:'US'}});
const saved=(id,street)=>({id,order_number:`ORDER-${id}`,raw_payload:{order:{fulfillmentStartInstructions:[{shippingStep:{shipTo:ship(street)}}],buyer:{buyerRegistrationAddress:ship('Wrong profile address')}}}});

test('report destination uses the original order ship-to snapshot and excludes private contact fields',()=>{
 const d=M.orderDestination(saved('A','10 Order Street'));
 assert.equal(d.orderNumber,'ORDER-A');assert.equal(d.recipient,'Order recipient');
 assert.deepEqual(d.addressLines,['10 Order Street','Unit 4','Example City, FL 33000','US']);
 assert.equal(d.source,'Saved eBay order');assert.doesNotMatch(JSON.stringify(d),/Wrong profile|private@|555-0100/);
});

test('direct API and imported Ship To fields are supported without borrowing buyer or billing addresses',()=>{
 const direct=M.orderDestination({raw_payload:{fulfillmentStartInstructions:[{shippingStep:{shipTo:ship('20 Direct Street')}}]}});
 assert.equal(direct.addressLines[0],'20 Direct Street');
 const imported=M.orderDestination({raw_payload:{first_row:{'Ship To Name':'Import recipient','Ship To Address 1':'30 Import Street','Ship To Address 2':'Floor 2','Ship To City':'London','Ship To Zip':'SW1A 1AA','Ship To Country':'GB','Buyer Address 1':'Wrong buyer street'}}});
 assert.equal(imported.recipient,'Import recipient');assert.deepEqual(imported.addressLines,['30 Import Street','Floor 2','London, SW1A 1AA','GB']);assert.equal(imported.source,'Imported order shipping address');
 const missing=M.orderDestination({buyer_name:'Buyer',raw_payload:{order:{buyer:{buyerRegistrationAddress:ship('Wrong profile address')}},billingAddress:ship('Wrong billing address')}});
 assert.deepEqual(missing.addressLines,[]);assert.equal(missing.recipient,'');
});

test('an incomplete saved address remains its own snapshot instead of filling gaps from another address',()=>{
 const order=saved('A','10 Order Street');order.raw_payload.order.fulfillmentStartInstructions[0].shippingStep.shipTo={contactAddress:{addressLine1:'10 Original Street'}};
 order.raw_payload.first_row={'Ship To Name':'Different recipient','Ship To City':'Different city','Ship To Address 1':'Different Street'};
 const d=M.orderDestination(order);assert.deepEqual(d.addressLines,['10 Original Street']);assert.equal(d.recipient,'');
});

test('shared shipment photos retain distinct order destinations and exact line scope',()=>{
 const a=saved('A','10 A Street'),b=saved('B','20 B Street'),c=saved('C','30 Other Street');
 const photo=path=>({bucket:'proof',path});
 const members=[{orders:[a,b,c],lines:[{id:'line-a',order_id:'A'},{id:'line-b',order_id:'B'}],completion_events:[
  {order_ids:['A','B'],order_line_ids:['line-a'],photo_attachments:[photo('exact.png')]},
  {order_ids:['A','B'],photo_attachments:[photo('combined.png')]},
  {order_ids:[],photo_attachments:[photo('unlinked.png')]}
 ]},{orders:[b],completion_events:[{order_ids:['B'],photo_attachments:[photo('combined.png')]}],packaging_photos:[photo('package.png')],return_photos:[photo('return.png')]}];
 const map=M.shipmentPhotoOrders(members);
 assert.deepEqual(map.get('proof/exact.png').map(d=>d.orderId),['A']);
 assert.deepEqual(map.get('proof/combined.png').map(d=>d.orderId),['A','B']);
 assert.deepEqual(map.get('proof/combined.png').map(d=>d.addressLines[0]),['10 A Street','20 B Street']);
 assert.deepEqual(map.get('proof/unlinked.png'),[]);
 assert.deepEqual(map.get('proof/package.png').map(d=>d.orderId),['B']);assert.equal(map.has('proof/return.png'),false);
});
