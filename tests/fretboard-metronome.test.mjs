import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {sanitizeSettings} from '../fretboard/music.mjs';
test('pendulum samples match their CC0 source manifest and have distinct, short clicks',async()=>{
  const dir=new URL('../fretboard/samples/metronome/',import.meta.url),manifest=JSON.parse(await readFile(new URL('sources.json',dir)));
  assert.equal(manifest.license,'CC0-1.0');assert.equal(manifest.samples.length,2);
  const hashes=[];
  for(const entry of manifest.samples){const data=await readFile(new URL(entry.file,dir)),hash=createHash('sha256').update(data).digest('hex');hashes.push(hash);assert.equal(hash,entry.sha256);assert.equal(data.toString('ascii',8,12),'WAVE');assert.equal(data.readUInt32LE(24),48000);assert.equal(data.readUInt16LE(22),1);assert.equal(data.readUInt16LE(34),16);assert.equal((data.length-44)/2/48000,.23);}
  assert.notEqual(hashes[0],hashes[1]);
});
test('old settings adopt mechanical sound while bad metronome values are sanitized',()=>{
  assert.equal(sanitizeSettings({}).metronomeSound,'mechanical');assert.equal(sanitizeSettings({metronomeSound:'unknown'}).metronomeSound,'mechanical');
  const s=sanitizeSettings({metronomeSound:'digital',metronomeVolume:150,metronomeAccent:false});assert.equal(s.metronomeSound,'digital');assert.equal(s.metronomeVolume,100);assert.equal(s.metronomeAccent,false);
});
