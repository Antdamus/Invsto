import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
const root=new URL('../',import.meta.url);let server,browser,origin;
before(async()=>{
  server=createServer(async(req,res)=>{const path=decodeURIComponent(new URL(req.url,'http://local').pathname);if(!/^\/fretboard\/(?:[a-z.-]+|samples\/(?:acoustic|metronome)\/[a-zA-Z0-9.-]+)$/.test(path)){res.writeHead(404).end();return;}try{const body=await readFile(new URL('.'+path,root));res.setHeader('Content-Type',path.endsWith('.mjs')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.wav')?'audio/wav':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch();await mkdir(new URL('test-results/',root),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,width=1440){
  const context=await browser.newContext({viewport:{width,height:1100}});t.after(()=>context.close());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(origin+'/fretboard/index.html');await expect(page.locator('.sheet-note')).toHaveCount(8);return page;
}

for(const width of [1440,390])test(`note map links every C octave to classical notation and physical locations at ${width}px`,async t=>{
  const page=await open(t,width);await page.locator('#map-open').click();
  await expect(page.locator('#note-map-dialog')).toBeVisible();await expect(page.locator('#map-note')).toBeFocused();
  await expect(page.locator('#map-neck .map-position')).toHaveCount(11);await expect(page.locator('.map-octave-card')).toHaveCount(4);
  assert.deepEqual(await page.locator('.map-card-heading h3').allTextContents(),['C3','C4','C5','C6']);
  await page.locator('#map-staves [data-map-string="3"][data-map-fret="5"]').click();
  await expect(page.locator('#map-selection')).toHaveText('C4 · string 3 · fret 5 · 261.6 Hz');
  await expect(page.locator('#map-neck [aria-pressed=true]')).toHaveCount(1);await expect(page.locator('[data-map-card="60"] .map-string-mark')).toHaveAttribute('visibility','visible');
  await expect(page.locator('[data-map-card="60"] .map-string-mark text')).toHaveText('3');
  await page.locator('#map-hear').click();await expect(page.locator('#correct')).toHaveText('0');await expect(page.locator('#clock')).toHaveText('00:00');
  await page.locator('#note-map-dialog').evaluate(el=>{el.scrollTop=0;});
  assert.ok(await page.evaluate(()=>{const d=document.getElementById('note-map-dialog');return document.documentElement.scrollWidth<=innerWidth&&d.scrollWidth<=d.clientWidth;}));
  await page.locator('#note-map-dialog').screenshot({path:new URL(`test-results/fretwise-map-${width}.png`,root).pathname.replace(/^\/(\w:)/,'$1')});
  await page.locator('[data-map-octave="60"]').click();await expect(page.locator('#map-neck .map-position')).toHaveCount(5);await expect(page.locator('.map-octave-card')).toHaveCount(1);
  const dot=page.locator('#map-neck [data-map-string="2"][data-map-fret="1"]');await dot.focus();await page.keyboard.press('Enter');await expect(dot).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Escape');await expect(page.locator('#note-map-dialog')).not.toBeVisible();await expect(page.locator('#map-open')).toBeFocused();
});

test('note map ignores practice filters and previews the recommendation without adding it',async t=>{
  const page=await open(t);await page.locator('.range-details summary').click();
  await page.locator('#min-fret').fill('1');await page.locator('#min-fret').press('Tab');await page.locator('#max-fret').fill('5');await page.locator('#max-fret').press('Tab');
  for(const oct of [2,3,5,6])await page.locator(`#octaves [data-octave="${oct}"]`).click();
  const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('fretwise.v1')).settings);
  await page.locator('#map-open').click();await expect(page.locator('#map-neck .map-position')).toHaveCount(11);
  await page.locator('#map-note').selectOption('4');await expect(page.locator('.map-octave-card')).toHaveCount(4);await expect(page.locator('#map-neck [data-map-string="6"][data-map-fret="0"]')).toBeVisible();
  await page.locator('#map-note').selectOption('1');await expect(page.locator('#map-title')).toHaveText('Meet C♯, everywhere.');
  await page.getByRole('button',{name:'Back to practice'}).click();
  const next=(await page.locator('#map-next').textContent()).match(/^Preview (.+) on/)[1];await page.locator('#map-next').click();await expect(page.locator('#map-title')).toHaveText(`Meet ${next}, everywhere.`);
  await page.keyboard.press('Escape');await expect(page.locator('#pool-count')).toHaveText('1 of 7');
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('fretwise.v1')).settings),before);
});

test('studying during a hidden-hint phrase pauses the timer and prevents an unaided milestone',async t=>{
  const page=await open(t);await page.clock.install();await page.locator('#bpm').fill('180');await page.locator('#bpm').press('Tab');await page.locator('#hints').uncheck();
  await page.locator('#play').click();await page.clock.runFor(1400);await page.locator('#map-current').click();
  const time=await page.locator('#clock').textContent();await page.clock.runFor(3000);await expect(page.locator('#clock')).toHaveText(time);
  await page.keyboard.press('Escape');await page.locator('#play').click();
  for(let n=0;n<8;n++){await page.locator('#got-it').click();await page.clock.runFor(n===7?670:667);}
  await page.locator('#play').click();
  const data=await page.evaluate(()=>JSON.parse(localStorage.getItem('fretwise.v1')));
  assert.ok(Object.values(data.progress.notes).every(n=>n.passes.length===0));await expect(page.locator('#correct')).toHaveText('8');
});

test('note-map reference tones respect microphone headphones mode and play the selected octave',async t=>{
  const page=await open(t);
  await page.evaluate(async()=>{
    const {StudioAudio}=await import('/fretboard/audio.mjs?v=4'),tone=StudioAudio.prototype.tone;window.mapTones=[];
    StudioAudio.prototype.tone=function(midi,...args){window.mapTones.push(midi);return tone.call(this,midi,...args);};
    navigator.mediaDevices.getUserMedia=async()=>{window.mapMicContext=new AudioContext();return window.mapMicContext.createMediaStreamDestination().stream;};
  });
  await page.locator('#mic').click();await expect(page.locator('#headphones-wrap')).toBeVisible();await page.locator('#map-open').click();
  await page.locator('#map-staves [data-map-string="1"][data-map-fret="20"]').click();await expect(page.locator('#map-hear')).toBeDisabled();await expect(page.locator('#map-audio-help')).toContainText('muted');
  await page.keyboard.press('Escape');await page.locator('#headphones').check();await page.locator('#map-open').click();
  await page.locator('#map-staves [data-map-string="1"][data-map-fret="20"]').click();await page.locator('#map-hear').click();
  assert.deepEqual(await page.evaluate(()=>window.mapTones),[84]);await expect(page.locator('#correct')).toHaveText('0');
  await page.keyboard.press('Escape');await page.locator('#mic').click();await page.evaluate(()=>window.mapMicContext.close());
});
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
  await page.locator('#mic').click();await expect(page.locator('#pitch-meter')).toBeHidden();await expect(page.locator('#headphones-wrap')).toBeHidden();await page.evaluate(()=>window.testTone.c.close());
});

async function watchDrums(page){
  await page.evaluate(async()=>{
    const {AcousticKit}=await import('/fretboard/drums.mjs?v=1'),original=AcousticKit.prototype.hit;
    window.testDrumHits=[];AcousticKit.prototype.hit=function(piece,time,velocity){window.testKit=this;window.testDrumHits.push({piece,time,velocity,now:this.context.currentTime});return original.call(this,piece,time,velocity);};
  });
}
test('real acoustic kit loads only on demand, previews without scoring, and persists its mix',async t=>{
  const page=await open(t);let samples=0;page.on('request',r=>{if(r.url().endsWith('.wav'))samples++;});await watchDrums(page);
  assert.equal(samples,0);await page.locator('#drums').selectOption('pop');assert.equal(samples,0);
  await page.locator('#drum-volume').fill('42');await page.locator('#drum-fills').uncheck();await page.locator('#drum-preview').click();
  await expect(page.locator('#drum-status')).toContainText('Acoustic kit ready',{timeout:15000});await page.waitForFunction(()=>window.testDrumHits.length>0);
  assert.equal(samples,24);await expect(page.locator('#clock')).toHaveText('00:00');await expect(page.locator('#correct')).toHaveText('0');
  const info=await page.evaluate(()=>({buffers:window.testKit.buffers.size,durations:[...window.testKit.buffers.values()].map(b=>b.duration),voices:window.testKit.voices.size}));
  assert.equal(info.buffers,24);assert.ok(info.durations.every(n=>n>.1&&n<30));assert.ok(info.voices>0);
  await page.locator('#drum-preview').click();assert.equal(await page.evaluate(()=>window.testKit.voices.size),0);
  await page.reload();await expect(page.locator('#drums')).toHaveValue('pop');await expect(page.locator('#drum-volume')).toHaveValue('42');await expect(page.locator('#drum-fills')).not.toBeChecked();
  await page.setViewportSize({width:390,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('.drum-room').screenshot({path:new URL('test-results/fretwise-drums-mobile.png',root).pathname.replace(/^\/(\w:)/,'$1')});
});
test('drums begin after the count-in, follow transport, and stop when switched off',async t=>{
  const page=await open(t);await watchDrums(page);await page.locator('#bpm').fill('180');await page.locator('#bpm').press('Tab');await page.locator('#metronome').uncheck();await page.locator('#drums').selectOption('rock');
  await page.locator('#play').click();await expect(page.locator('#play')).toContainText('Pause',{timeout:15000});assert.equal(await page.evaluate(()=>window.testDrumHits.length),0);
  await page.waitForFunction(()=>window.testDrumHits.length>0,{timeout:5000});await expect(page.locator('#drum-preview')).toBeDisabled();
  await page.waitForFunction(()=>window.testDrumHits.filter(h=>h.piece==='crash').length>=2,null,{timeout:10000});
  const downbeats=await page.evaluate(()=>window.testDrumHits.filter(h=>h.piece==='crash').map(h=>h.time));
  assert.ok(Math.abs(downbeats[1]-downbeats[0]-16*60/180)<.04,`four-bar loop drifted: ${downbeats}`);
  await page.locator('#play').click();const paused=await page.evaluate(()=>({hits:window.testDrumHits.length,voices:window.testKit.voices.size}));assert.equal(paused.voices,0);
  await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>window.testDrumHits.length),paused.hits);
  await page.locator('#play').click();await page.waitForFunction(n=>window.testDrumHits.length>n,paused.hits);
  await page.locator('#drums').selectOption('off');await expect(page.locator('#drum-controls')).toBeHidden();assert.equal(await page.evaluate(()=>window.testKit.voices.size),0);
});
test('failed samples offer retry and do not prevent drums-off manual practice',async t=>{
  const page=await open(t);await page.route('**/samples/acoustic/*.wav',route=>route.abort());await page.locator('#drums').selectOption('pop');await page.locator('#play').click();
  await expect(page.locator('#drum-status')).toContainText('Kit download failed');await expect(page.locator('#drum-retry')).toBeVisible();await expect(page.locator('#play')).toContainText('Play score');
  await page.unroute('**/samples/acoustic/*.wav');await page.locator('#drum-retry').click();await expect(page.locator('#drum-status')).toContainText('Acoustic kit ready',{timeout:15000});
  await page.locator('#drums').selectOption('off');await page.locator('#play').click();await expect(page.locator('#play')).toContainText('Pause');
});
test('canceling playback while the kit loads cannot start the score later',async t=>{
  const page=await open(t);let release;const gate=new Promise(resolve=>{release=resolve;});await page.route('**/samples/acoustic/*.wav',async route=>{await gate;await route.continue();});await page.locator('#drums').selectOption('pop');await page.locator('#play').click();
  await expect(page.locator('#drum-status')).toContainText('Loading 24');await page.locator('#play').click();await expect(page.locator('#play')).toContainText('Play score');
  release();await expect(page.locator('#drum-status')).toContainText('Acoustic kit ready',{timeout:15000});
  await expect(page.locator('#play')).toContainText('Play score');await expect(page.locator('#clock')).toHaveText('00:00');
});
test('sample engine renders actual audio, alternates takes, chokes hats and mutes microphone playback',async t=>{
  const page=await open(t);
  const rendered=await page.evaluate(async()=>{
    const {AcousticKit}=await import('/fretboard/drums.mjs?v=1'),{StudioAudio}=await import('/fretboard/audio.mjs?v=4');
    const context=new OfflineAudioContext(2,44100*2,44100),kit=new AcousticKit(context,context.destination);await kit.load();
    kit.hit('openhat',.05,.8);const open=[...kit.voices][0];kit.hit('hat',.3,.8);kit.hit('hat',.6,.8);kit.hit('kick',.1,.8);kit.hit('kick',1,.8);
    const kickBuffers=[...kit.voices].filter(v=>v.piece==='kick').map(v=>v.source.buffer);const alternates=kickBuffers[0]!==kickBuffers[1],chokedAt=open.chokedAt;
    const buffer=await context.startRendering();let peak=0,energy=0;for(const v of buffer.getChannelData(0)){peak=Math.max(peak,Math.abs(v));energy+=v*v;}
    const audio=new StudioAudio();await audio.init();let calls=0;audio.drums.beat=()=>calls++;
    const settings={drums:'pop',drumVolume:60,drumFills:true,metronome:false,backing:'off',bpm:120};
    audio.muted=true;audio.beat(audio.context.currentTime,0,settings);const mutedCalls=calls;audio.muted=false;audio.beat(audio.context.currentTime,0,settings);audio.stopVoices();await audio.context.close();
    return {alternates,chokedAt,peak,energy,mutedCalls,calls};
  });
  assert.equal(rendered.alternates,true);assert.equal(rendered.chokedAt,.3);assert.ok(rendered.energy>5);assert.ok(rendered.peak>0&&rendered.peak<1);assert.equal(rendered.mutedCalls,0);assert.equal(rendered.calls,1);
});

test('mechanical metronome previews four recorded beats at tempo and saves its controls',async t=>{
  const page=await open(t,390);await expect(page.locator('#metronome-sound')).toHaveValue('mechanical');
  await page.evaluate(async()=>{const {PendulumMetronome}=await import('/fretboard/metronome.mjs?v=1'),beat=PendulumMetronome.prototype.beat;window.testClicks=[];PendulumMetronome.prototype.beat=function(time,n,s){window.testMetronome=this;window.testClicks.push({time,n});return beat.call(this,time,n,s);};});
  await page.locator('#bpm').fill('180');await page.locator('#bpm').press('Tab');await page.locator('#metronome-volume').fill('56');await page.locator('#metronome-accent').uncheck();await page.locator('#metronome-preview').click();
  await expect(page.locator('#metronome-preview')).toHaveText('■ Stop preview');await expect(page.locator('#metronome-preview')).toHaveText('▶ Preview metronome',{timeout:5000});
  const preview=await page.evaluate(()=>({clicks:window.testClicks,buffers:window.testMetronome.buffers.size,voices:window.testMetronome.voices.size}));
  assert.equal(preview.buffers,2);assert.equal(preview.voices,0);assert.deepEqual(preview.clicks.map(c=>c.n),[0,1,2,3]);for(let i=1;i<4;i++)assert.ok(Math.abs(preview.clicks[i].time-preview.clicks[i-1].time-1/3)<.001);
  await expect(page.locator('#clock')).toHaveText('00:00');await expect(page.locator('#correct')).toHaveText('0');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('.metronome-room').screenshot({path:new URL('test-results/fretwise-metronome-mobile.png',root).pathname.replace(/^\/(\w:)/,'$1')});
  await page.reload();await expect(page.locator('#metronome-volume')).toHaveValue('56');await expect(page.locator('#metronome-accent')).not.toBeChecked();
});
test('metronome download failure uses a disclosed digital fallback and preview can retry',async t=>{
  const page=await open(t);await page.route('**/samples/metronome/*.wav',route=>route.abort());await page.locator('#metronome-preview').click();
  await expect(page.locator('#metronome-status')).toContainText('using a digital click');await expect(page.locator('#metronome-preview')).toHaveText('■ Stop preview');await page.locator('#metronome-preview').click();
  await page.unroute('**/samples/metronome/*.wav');await page.locator('#metronome-preview').click();await expect(page.locator('#metronome-status')).toContainText('Actual pendulum');await page.locator('#metronome-preview').click();
  await page.locator('#metronome-sound').selectOption('digital');await page.locator('#play').click();await expect(page.locator('#play')).toContainText('Pause');
});
test('recorded metronome alternates tick and tock, accents beat one and obeys mute/count-in rules',async t=>{
  const page=await open(t);
  const result=await page.evaluate(async()=>{
    const {PendulumMetronome}=await import('/fretboard/metronome.mjs?v=1'),{StudioAudio}=await import('/fretboard/audio.mjs?v=4');
    const context=new OfflineAudioContext(1,48000*3,48000),m=new PendulumMetronome(context,context.destination);await m.load();
    const settings={metronomeSound:'mechanical',metronomeVolume:75,metronomeAccent:true,metronome:false,drums:'off',backing:'off'};
    for(let n=0;n<4;n++)m.beat(.1+n*.5,n,settings);
    const voices=[...m.voices],alternates=voices[0].buffer===voices[2].buffer&&voices[0].buffer!==voices[1].buffer;
    const rendered=await context.startRendering(),data=rendered.getChannelData(0),energies=[];
    for(let n=0;n<4;n++){let sum=0;for(let i=Math.round((.1+n*.5)*48000);i<(.34+n*.5)*48000;i++)sum+=data[i]**2;energies.push(sum);}
    const audio=new StudioAudio();await audio.init();const heard=[];audio.metronome.beat=(_,beat)=>heard.push(beat);
    audio.beat(audio.context.currentTime,-4,settings);audio.beat(audio.context.currentTime,0,settings);audio.muted=true;audio.beat(audio.context.currentTime,-3,settings);audio.muted=false;audio.beat(audio.context.currentTime,1,{...settings,metronome:true});audio.stopVoices();await audio.context.close();
    return {alternates,energies,heard};
  });
  assert.equal(result.alternates,true);assert.ok(result.energies.every(e=>e>1));assert.ok(Math.abs(result.energies[0]/result.energies[2]-1/.7**2)<.02);assert.deepEqual(result.heard,[-4,1]);
});
