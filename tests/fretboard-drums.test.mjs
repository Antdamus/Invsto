import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {drumHits,DRUM_STYLES,DRUM_FILES,DRUM_PIECES} from '../fretboard/drums.mjs';
import {sanitizeSettings} from '../fretboard/music.mjs';

test('grooves fit the beat grid at every tempo and count-in is silent',()=>{
  for(const style of DRUM_STYLES){
    for(let beat=-4;beat<32;beat++)for(const fills of [false,true]){
      const hits=drumHits(beat,style,fills);
      if(beat<0||style==='off')assert.equal(hits.length,0);
      for(const hit of hits){assert.ok(DRUM_PIECES.includes(hit.piece));assert.ok(hit.offset>=0&&hit.offset<1);assert.ok(hit.velocity>0&&hit.velocity<=1);}
      assert.deepEqual(hits.map(h=>h.offset),hits.map(h=>h.offset).sort((a,b)=>a-b));
    }
    if(style!=='off')assert.ok(drumHits(0,style,false).some(h=>h.piece==='kick'&&h.offset===0));
  }
  assert.ok(drumHits(0,'shuffle',false).some(h=>h.offset===2/3));
  assert.ok(drumHits(1,'pop',false).some(h=>h.piece==='snare'&&h.offset===0));
  assert.equal(drumHits(1,'halftime',false).some(h=>h.piece==='snare'),false);
  assert.ok(drumHits(2,'halftime',false).some(h=>h.piece==='snare'));
});
test('fills use all three toms only at the end of a four-bar phrase',()=>{
  for(const style of DRUM_STYLES.filter(s=>s!=='off')){
    const fills=Array.from({length:16},(_,beat)=>drumHits(beat,style,true));
    assert.equal(fills.slice(0,14).flat().some(h=>h.piece.startsWith('tom')),false);
    assert.deepEqual([...new Set(fills.flat().filter(h=>h.piece.startsWith('tom')).map(h=>h.piece))],['tomhi','tommid','tomlow']);
    assert.equal(Array.from({length:16},(_,b)=>drumHits(b,style,false)).flat().some(h=>h.piece.startsWith('tom')),false);
  }
});
test('bundled recordings are stereo PCM, non-silent and match the source manifest',async()=>{
  const dir=new URL('../fretboard/samples/acoustic/',import.meta.url),manifest=JSON.parse(await readFile(new URL('sources.json',dir)));
  assert.equal(manifest.license,'CC0-1.0');assert.equal(manifest.samples.length,24);
  for(const name of DRUM_FILES){
    const wave=await readFile(new URL(name,dir)),entry=manifest.samples.find(s=>s.file===name);
    assert.equal(wave.toString('ascii',0,4),'RIFF');assert.equal(wave.toString('ascii',8,12),'WAVE');
    assert.equal(createHash('sha256').update(wave).digest('hex'),entry.sha256);
    let samples,fmt;for(let at=12;at+8<wave.length;){const size=wave.readUInt32LE(at+4),type=wave.toString('ascii',at,at+4);if(type==='fmt ')fmt=wave.subarray(at+8,at+8+size);if(type==='data')samples=wave.subarray(at+8,at+8+size);at+=8+size+size%2;}
    assert.equal(fmt.readUInt16LE(2),2);assert.equal(fmt.readUInt32LE(4),44100);assert.equal(fmt.readUInt16LE(14),16);
    let peak=0,energy=0;for(let i=0;i<samples.length;i+=2){const x=samples.readInt16LE(i)/32768;peak=Math.max(peak,Math.abs(x));energy+=x*x;}
    assert.ok(peak>.05&&peak<.99,`${name} peak ${peak}`);assert.ok(energy>1,`${name} is silent`);
  }
});
test('drum settings recover from old storage and constrain volume and styles',()=>{
  assert.equal(sanitizeSettings({}).drums,'off');assert.equal(sanitizeSettings({drums:'unknown'}).drums,'off');
  const s=sanitizeSettings({drums:'shuffle',drumVolume:500,drumFills:false});assert.equal(s.drums,'shuffle');assert.equal(s.drumVolume,100);assert.equal(s.drumFills,false);
});
