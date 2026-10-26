import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
const root=new URL('../',import.meta.url);let server,browser,origin;
before(async()=>{
  server=createServer(async(req,res)=>{const path=decodeURIComponent(new URL(req.url,'http://local').pathname);if(!/^\/fretboard\/[a-z.-]+$/.test(path)){res.writeHead(404).end();return;}try{const body=await readFile(new URL('.'+path,root));res.setHeader('Content-Type',path.endsWith('.mjs')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch();await mkdir(new URL('test-results/',root),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,width=1440){
  const context=await browser.newContext({viewport:{width,height:1100}});t.after(()=>context.close());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(origin+'/fretboard/index.html');await expect(page.locator('.sheet-note')).toHaveCount(8);return page;
}
for(const width of [1440,390])test(`real notation and full-neck setup render without page overflow at ${width}px`,async t=>{
  const page=await open(t,width);await expect(page.locator('#range-summary')).toHaveText('All strings · frets 0–21');
  assert.equal(await page.locator('#octaves [aria-pressed=true]').count(),5);
  const notes=await page.locator('.note-hint').allTextContents();assert.deepEqual([...new Set(notes)].sort(),['C3','C4','C5','C6']);
  assert.equal(await page.locator('.staff-line').count(),10);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:new URL(`test-results/fretwise-${width}.png`,root).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
});
test('tempo, range, scale, note palette and hidden-note reading persist',async t=>{
  const page=await open(t);await page.locator('#bpm').fill('90');await page.locator('#bpm').press('Tab');
  await page.locator('#scale').selectOption('minor');await page.locator('#add-note').click();
  await expect(page.locator('#pool-count')).toHaveText('2 of 7');
  await page.locator('#hints').uncheck();assert.ok((await page.locator('.note-hint').allTextContents()).every(x=>!x));
  await page.reload();await expect(page.locator('#bpm')).toHaveValue('90');await expect(page.locator('#scale')).toHaveValue('minor');await expect(page.locator('#hints')).not.toBeChecked();
});
test('timed score counts in, advances, pauses, resumes and completes without loop',async t=>{
  const page=await open(t);await page.clock.install();await page.locator('#bpm').fill('120');await page.locator('#bpm').press('Tab');await page.locator('#loop').uncheck();
  await page.locator('#play').click();await page.clock.runFor(2100);await expect(page.locator('#cue-label')).toHaveText('NOW · SOUNDING PITCH');
  await page.locator('#got-it').click();await expect(page.locator('#correct')).toHaveText('1');
  await page.locator('#play').click();const timer=await page.locator('#clock').textContent();await page.clock.runFor(2000);await expect(page.locator('#clock')).toHaveText(timer);
  await page.locator('#play').click();await page.clock.runFor(8500);await expect(page.locator('#cue-message')).toHaveText('Phrase complete.');
  await expect(page.locator('#play')).toHaveText('▶ Play again');assert.equal(await page.locator('.sheet-note.miss').count(),7);
});
test('wait mode advances only after correct input and can resume during success feedback',async t=>{
  const page=await open(t);await page.clock.install();await page.locator('#mode').selectOption('wait');await page.locator('#bpm').fill('180');await page.locator('#bpm').press('Tab');
  await page.locator('#play').click();await page.clock.runFor(1450);await page.clock.runFor(3000);assert.equal(await page.locator('.sheet-note.current').getAttribute('data-note-index'),'0');
  await page.locator('#got-it').click();await page.locator('#play').click();await page.locator('#play').click();await page.clock.runFor(450);assert.equal(await page.locator('.sheet-note.current').getAttribute('data-note-index'),'1');
  await page.locator('#skip').click();assert.equal(await page.locator('.sheet-note.current').getAttribute('data-note-index'),'2');
});
test('denied microphone permission leaves manual practice usable',async t=>{
  const page=await open(t);await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Permission denied','NotAllowedError');};});
  await page.locator('#mic').click();await expect(page.locator('#mic-status')).toContainText('permission was declined');await expect(page.locator('#got-it')).toBeEnabled();await expect(page.locator('#play')).toBeEnabled();
});
test('classical string instructions enforce the assigned location, even for the same sounding pitch',async t=>{
  const page=await open(t);await page.clock.install();await page.locator('#mode').selectOption('wait');await page.locator('#bpm').fill('180');await page.locator('#bpm').press('Tab');
  for(const oct of [2,3,5,6])await page.locator(`[data-octave="${oct}"]`).click();
  const string=Number(await page.locator('.sheet-note.current .string-indication text').textContent());
  const frets={2:1,3:5,4:10,5:15,6:20};const alternate=Object.keys(frets).map(Number).find(s=>s!==string);
  await page.locator('#play').click();await page.clock.runFor(1450);
  await page.locator(`#fretboard [data-string="${alternate}"][data-fret="${frets[alternate]}"]`).click();
  await expect(page.locator('#cue-message')).toHaveText(`Right pitch. Try string ${string}.`);await expect(page.locator('#correct')).toHaveText('0');
  await page.locator(`#fretboard [data-string="${string}"][data-fret="${frets[string]}"]`).click();await expect(page.locator('#correct')).toHaveText('1');
});
test('two clean unassisted passes record separate octave milestones and recommend another note',async t=>{
  const page=await open(t);await page.clock.install();await page.locator('#bpm').fill('180');await page.locator('#bpm').press('Tab');await page.locator('#hints').uncheck();
  await page.locator('#play').click();await page.clock.runFor(1400);
  for(let pass=0;pass<2;pass++)for(let n=0;n<8;n++){
    await page.locator('#got-it').click();await page.clock.runFor(n===7?670:667);
  }
  await page.locator('#play').click();await expect(page.locator('#mastery-label')).toHaveText('4 / 4 pitches at goal');await expect(page.locator('#mastery-help')).toContainText('Ready for another note');
  const data=await page.evaluate(()=>JSON.parse(localStorage.getItem('fretwise.v1')));for(const midi of [48,60,72,84])assert.ok(data.progress.notes[midi].passes.length>=2);
  await page.locator('#add-note').click();await expect(page.locator('#pool-count')).toHaveText('2 of 7');await expect(page.locator('#mastery-label')).not.toHaveText('8 / 8 pitches at goal');
});
test('generated backing, local audio selection, session timer and history work together',async t=>{
  const page=await open(t);await page.clock.install();await page.locator('#backing').selectOption('groove');await page.locator('#goal').selectOption('3');await page.locator('#play').click();await page.clock.runFor(4500);
  await page.locator('#got-it').click();await page.locator('#finish').click();await expect(page.locator('#summary-dialog')).toBeVisible();await expect(page.locator('#history-copy')).toContainText('1 saved session');
  await page.getByRole('button',{name:'Back to the fretboard'}).click();await page.locator('#backing').selectOption('upload');await expect(page.locator('#upload-wrap')).toBeVisible();
  await page.locator('#audio-file').setInputFiles({name:'practice.wav',mimeType:'audio/wav',buffer:Buffer.alloc(44)});await expect(page.locator('#audio-name')).toHaveText('practice.wav');
});
test('microphone checks real octave from synthetic audio; a held note cannot answer repeatedly',async t=>{
  const page=await open(t);await page.locator('#mode').selectOption('wait');await page.locator('#bpm').fill('180');await page.locator('#bpm').press('Tab');
  for(const oct of [2,3,5,6])await page.locator(`[data-octave="${oct}"]`).click();
  await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext(),o=c.createOscillator(),g=c.createGain(),out=c.createMediaStreamDestination();o.frequency.value=523.251;g.gain.value=.15;o.connect(g);g.connect(out);o.start();window.testTone={c,o,g};await c.resume();return out.stream;};});
  await page.locator('#mic').click();await expect(page.locator('#heard-pitch')).toHaveText('C5');
  await page.locator('#headphones').check();await expect(page.locator('#mic-status')).toContainText('Headphones mode');
  await page.locator('#headphones').uncheck();await expect(page.locator('#mic-status')).toContainText('App audio is muted');await page.locator('#play').click();
  await expect(page.locator('#cue-label')).toHaveText('NOW · SOUNDING PITCH',{timeout:5000});
  await page.waitForTimeout(400);await expect(page.locator('#correct')).toHaveText('0');
  await page.evaluate(()=>{window.testTone.o.frequency.value=261.6256;});await expect(page.locator('#correct')).toHaveText('1',{timeout:3000});
  await page.waitForTimeout(900);await expect(page.locator('#correct')).toHaveText('1');
  await page.locator('#mic').click();await expect(page.locator('#pitch-meter')).toBeHidden();await page.evaluate(()=>window.testTone.c.close());
});
