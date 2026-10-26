import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {guitarSample} from '../fretboard/guitar.mjs';
import {DEFAULTS,sanitizeSettings,TUNING} from '../fretboard/music.mjs';

test('all 723 guitar recordings match the publisher checksums and cover every expected string/layer',async()=>{
  for(const [kind,count] of [['steel',375],['nylon',348]]){
    const manifest=JSON.parse(await readFile(new URL(`../fretboard/samples/guitar/sources-${kind}.json`,import.meta.url)));
    assert.equal(manifest.license,'CC0-1.0');assert.equal(manifest.samples.length,count);
    const keys=new Set();
    for(const entry of manifest.samples){
      const data=await readFile(new URL('../fretboard/samples/guitar/'+entry.file,import.meta.url));
      assert.equal(data.toString('ascii',0,4),'OggS');assert.equal(data.length,entry.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),entry.sha256);
      const key=`${entry.string}:${entry.midi}:${entry.layer}`;assert.ok(!keys.has(key));keys.add(key);
    }
    let shifted=0;
    for(let string=1;string<=6;string++)for(let fret=0;fret<=21;fret++)for(const layer of [1,2,3]){
      const midi=TUNING[string-1]+fret,sample=guitarSample({kind,string,midi,layer});
      assert.ok(keys.has(`${string}:${sample.root}:${layer}`));assert.equal(sample.string,string);
      assert.ok(Math.abs(sample.root+12*Math.log2(sample.rate)-midi)<1e-10);
      assert.ok(Math.abs(sample.semitones)<=(kind==='steel'?1:3));if(layer===1&&sample.semitones)shifted++;
    }
    assert.equal(shifted,kind==='steel'?7:16);
  }
});

test('same pitch on different strings has distinct recordings, including missing and upper-fret cases',()=>{
  assert.notEqual(guitarSample({midi:60,string:2}).file,guitarSample({midi:60,string:6}).file);
  assert.equal(guitarSample({midi:47,string:6}).root,48);
  assert.equal(guitarSample({midi:85,string:1}).semitones,1);
  assert.equal(guitarSample({midi:80,string:2,kind:'nylon'}).semitones,3);
  assert.throws(()=>guitarSample({midi:39,string:6}));assert.throws(()=>guitarSample({midi:60,string:8}));
});

test('saved guitar settings default sensibly and reject invalid voice/layer/level values',()=>{
  assert.equal(DEFAULTS.guitarSound,'steel');assert.equal(sanitizeSettings({}).guitarTouch,2);
  const s=sanitizeSettings({guitarSound:'nylon',guitarTouch:1,guitarVolume:92});assert.equal(s.guitarSound,'nylon');assert.equal(s.guitarTouch,1);assert.equal(s.guitarVolume,92);
  const bad=sanitizeSettings({guitarSound:'wrong',guitarTouch:99,guitarVolume:1000});assert.equal(bad.guitarSound,'steel');assert.equal(bad.guitarTouch,2);assert.equal(bad.guitarVolume,100);
});
