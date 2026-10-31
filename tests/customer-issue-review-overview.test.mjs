import {test} from 'node:test';
import assert from 'node:assert/strict';
import M from '../customer-issue-review-model.js';
const issue=overrides=>({review:{position:'Our position',requested_resolution:'Review the decision'},statuses:[{number:'A',lane:'Case',label:'Decided against us',claim:'$480.00',refund:'Not recorded'}],against:true,tracking:[],files:[{group:'completion',image:{}}],items:[{destination:{addressLines:['10 Example Street']}}],...overrides});
test('overview keeps claim, refund and delivery distinct and does not count a delivered return as outbound',()=>{
 const o=M.overview(issue({tracking:[{direction:'return',status:'Delivered',code:'RETURN'}]}));
 assert.equal(o.facts[1].value,'$480.00');assert.equal(o.facts[2].value,'Not recorded');assert.equal(o.facts[3].value,'Not recorded');
 assert.equal(o.outbound,0);assert(o.needs.some(n=>n.label==='Verify the refund status'));assert(o.needs.some(n=>n.label==='Find the outbound tracking'));
});
test('mixed shipment statuses and multiple claims stay explicit instead of implying full delivery or adding claims together',()=>{
 const o=M.overview(issue({statuses:[{number:'A',claim:'$480.00',refund:'Refunded'},{number:'B',claim:'$480.00',refund:'Not recorded'}],tracking:[{direction:'outbound',status:'Delivered',code:'A'},{direction:'outbound',status:'In transit',code:'B'}]}));
 assert.equal(o.facts[1].value,'2 case amounts');assert.equal(o.facts[1].note,'A: $480.00 · B: $480.00');assert.equal(o.facts[3].value,'1 of 2 marked delivered');assert.equal(o.facts[3].tone,'');
});
test('overview identifies unsaved evidence and text without altering the underlying records',()=>{
 const original=issue({review:{position:'',requested_resolution:''},files:[{group:'completion',error:'Unavailable'}],items:[{destination:{addressLines:[]}}]});const copy=JSON.stringify(original);const o=M.overview(original);
 assert.equal(o.photos,0);assert.equal(o.files,1);assert(o.needs.some(n=>n.section==='photos'));assert(o.needs.some(n=>n.label==='Write our position'));assert(o.needs.some(n=>n.label==='Verify the order ship-to address'));assert.equal(JSON.stringify(original),copy);
 assert.equal(M.excerpt('Full original text',8),'Full ori…');assert.equal(M.excerpt('Short'),'Short');
});
