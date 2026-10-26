import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,TUNING,positions,makeScore,noteName,frequency,pitchMatch,detectPitch,scalePCs,spell,sanitizeSettings,masteryFor,recommendation} from '../fretboard/music.mjs';
test('21-fret neck includes every C position and four distinct sounding registers',()=>{
  const p=positions(DEFAULTS);assert.deepEqual([...new Set(p.map(p=>p.midi))].sort((a,b)=>a-b),[48,60,72,84]);
  for(let string=1;string<=6;string++)for(let fret=0;fret<=21;fret++)assert.equal(p.some(p=>p.string===string&&p.fret===fret),(TUNING[string-1]+fret)%12===0);
  assert.equal(noteName(60),'C4');assert.equal(noteName(72),'C5');assert.equal(noteName(84),'C6');assert.equal(frequency(69),440);
});
test('score is four complete bars, covers all C registers, and assigns a valid string',()=>{
  for(const duration of [1,2,4]){
    const s={...DEFAULTS,duration},score=makeScore(s);
    assert.equal(score.reduce((n,e)=>n+e.duration,0),16);
    assert.equal(new Set(score.slice(0,4).map(e=>e.midi)).size,4);
    score.forEach((e,i)=>{assert.equal(e.beat,i*duration);assert.equal(TUNING[e.position.string-1]+e.position.fret,e.midi);assert.ok(e.position.fret<=21);});
  }
});
test('practice can be restricted without producing unavailable notes',()=>{
  const s={...DEFAULTS,strings:[2],octaves:[4],maxFret:5};assert.deepEqual(positions(s),[{string:2,fret:1,midi:60}]);
  assert.equal(makeScore({...s,maxFret:0}).length,0);
});
test('same letter in another octave is rejected; tuning tolerance is enforced',()=>{
  for(const midi of [48,60,72,84]){
    assert.equal(pitchMatch(midi,frequency(midi)).correct,true);
    assert.equal(pitchMatch(midi,frequency(midi+12)).correct,false);
    assert.equal(pitchMatch(midi,frequency(midi+12)).octaveError,true);
    assert.equal(pitchMatch(midi,frequency(midi)*2**(.5/12)).correct,false);
  }
});
test('YIN distinguishes guitar registers with harmonic-rich waves at both audio sample rates',()=>{
  for(const rate of [44100,48000])for(const midi of [40,48,52,60,64,72,84,85]){
    const data=Float32Array.from({length:4096},(_,i)=>{const t=2*Math.PI*frequency(midi)*i/rate;return .2*Math.sin(t)+.24*Math.sin(2*t)+.09*Math.sin(3*t);});
    const detected=detectPitch(data,rate);assert.ok(detected,`no detection ${midi}`);
    assert.ok(pitchMatch(midi,detected.frequency,8).correct,`${midi} detected as ${detected.frequency}`);
  }
  assert.equal(detectPitch(new Float32Array(4096),48000),null);
});
test('key spellings and staff placement preserve pitch, including enharmonic octaves',()=>{
  const natural={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
  for(let root=0;root<12;root++)for(const scale of ['major','minor','pentatonic','chromatic']){
    const s={...DEFAULTS,root,scale};for(const pc of scalePCs(s)){const n=spell(60+pc,s);assert.equal(12*(n.oct+1)+natural[n.letter]+n.acc,60+pc);}
  }
  assert.equal(spell(72,{...DEFAULTS,root:1}).name,'C5'); // D-flat major C is natural.
  assert.equal(spell(60+12,DEFAULTS).step-spell(60,DEFAULTS).step,7);
});
test('mastery is exact-octave, rhythm-specific, requires repeated unaided evidence',()=>{
  const passes=[{bpm:110,duration:2,hints:false,hits:2},{bpm:100,duration:2,hints:false,hits:2}];
  const progress={notes:{60:{passes,correct:4,attempts:4}}};
  assert.equal(masteryFor(60,progress,DEFAULTS).ready,true);assert.equal(masteryFor(72,progress,DEFAULTS).ready,false);
  assert.equal(masteryFor(60,progress,{...DEFAULTS,targetBpm:120}).ready,false);
  assert.equal(masteryFor(60,progress,{...DEFAULTS,duration:1}).ready,false);
  assert.equal(masteryFor(60,{notes:{60:{passes:passes.map(p=>({...p,hints:true}))}}},DEFAULTS).ready,false);
  const rec=recommendation(DEFAULTS,progress);assert.notEqual(rec.weak,60);assert.equal(rec.ready,false);
});
test('recommendations grow from learned pitches while keeping weak octaves in practice',()=>{
  const notes={};for(const midi of [48,60,72,84])notes[midi]={correct:8,attempts:8,passes:[{bpm:100,duration:2,hints:false,hits:2},{bpm:100,duration:2,hints:false,hits:2}]};
  const r=recommendation(DEFAULTS,{notes});assert.equal(r.ready,true);assert.equal(r.mastered,4);assert.ok([2,11].includes(r.next));
  assert.equal(recommendation({...DEFAULTS,pool:scalePCs(DEFAULTS)},{notes}).ready,false);
});
test('settings stay inside guitar and tempo bounds and recover from stale data',()=>{
  const s=sanitizeSettings({root:999,scale:'unknown',bpm:900,maxFret:99,minFret:-12,strings:[],pool:[99],octaves:[8]});
  assert.equal(s.bpm,180);assert.equal(s.maxFret,24);assert.equal(s.minFret,0);assert.equal(s.root,11);assert.ok(s.pool.length);assert.equal(s.strings.length,6);
});
