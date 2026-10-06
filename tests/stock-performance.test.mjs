import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

const source=await readFile(new URL('../stock.js',import.meta.url),'utf8');
const renderSource=source.slice(source.indexOf('async function renderStockItems('),source.indexOf('function highlightReturnedStockCard('));
function app() {
  const context=vm.createContext({console});
  const run=code=>vm.runInContext(code,context);
  run(`var stockListRenderToken=0, started=[], finish=[], mounted=[], icons=0, highlights=0;
    var grid={innerHTML:'',appendChild:fragment=>mounted.push(...fragment.cards)};
    var document={getElementById:()=>grid,createDocumentFragment:()=>({cards:[],appendChild(card){this.cards.push(card)}})};
    var lucide={createIcons:()=>icons++},window={lucide};
    var highlightReturnedStockCard=()=>highlights++;
    var renderStockCard=(item,index)=>{
      started.push({item,index});return new Promise(resolve=>finish.push(()=>resolve(item)));
    };
    ${renderSource}`);
  return {run};
}

test('Stock overlaps four cards at a time and keeps sorted order despite out-of-order responses',async()=>{
  const {run}=app();
  const pending=run(`renderStockItems(['a','b','c','d','e','f'])`);
  assert.equal(run('started.length'),4);
  run('finish[3]();finish[1]();finish[0]()');
  await new Promise(r=>setImmediate(r));
  assert.equal(run('started.length'),4);
  run('finish[2]()');
  await new Promise(r=>setImmediate(r));
  assert.equal(run('started.map(s=>s.index).join(",")'),'0,1,2,3,4,5');
  assert.equal(run('mounted.length'),0);
  run('finish[5]();finish[4]()');await pending;
  assert.equal(run('mounted.join(",")'),'a,b,c,d,e,f');
  assert.equal(run('icons'),1);assert.equal(run('highlights'),1);
});

test('a newer Stock search stops old batches and prevents stale cards from replacing its results',async()=>{
  const {run}=app();
  const old=run(`renderStockItems(['a','b','c','d','must-not-start'])`);
  const fresh=run(`renderStockItems(['new'])`);
  run('finish[4]()');await fresh;
  run('finish.slice(0,4).forEach(done=>done())');await old;
  assert.equal(run('started.length'),5);
  assert.equal(run('mounted.join(",")'),'new');
  assert.equal(run('icons'),1);
});
