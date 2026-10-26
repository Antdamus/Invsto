// Isolate two alternating clicks from a CC0 physical pendulum metronome recording.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source='https://bigsoundbank.com/UPLOAD/bwf-en/0468.wav';
const response=await fetch(source,{signal:AbortSignal.timeout(25000)});if(!response.ok)throw Error(`Download failed: ${response.status}`);
const original=Buffer.from(await response.arrayBuffer());let data,format;
for(let at=12;at+8<original.length;){const size=original.readUInt32LE(at+4),type=original.toString('ascii',at,at+4);if(type==='fmt ')format=original.subarray(at+8,at+8+size);if(type==='data')data=original.subarray(at+8,at+8+size);at+=8+size+size%2;}
if(!data||format.readUInt16LE(0)!==1||format.readUInt16LE(2)!==1||format.readUInt16LE(14)!==16)throw Error('Expected mono 16-bit PCM source');
const rate=format.readUInt32LE(4),out=new URL('../fretboard/samples/metronome/',import.meta.url);await mkdir(out,{recursive:true});
const clips=[['tick',2.024],['tock',2.502]].map(([name,peakTime])=>{
  let start=Math.floor((peakTime-.035)*rate);while(start<peakTime*rate&&Math.abs(data.readInt16LE(start*2))/32768<.025)start++;
  start=Math.max(0,start-Math.round(rate*.001));
  const samples=Array.from({length:Math.round(rate*.23)},(_,i)=>data.readInt16LE((start+i)*2)/32768);
  return {name,start,samples};
});
let peak=0;for(const clip of clips)for(const value of clip.samples)peak=Math.max(peak,Math.abs(value));
const manifest={author:'Joseph SARDIN / BigSoundBank',title:'Mechanical metronome (sound 0468)',license:'CC0-1.0',page:'https://bigsoundbank.com/metronome-a-120bpm-s0468.html',source,sourceSha256:createHash('sha256').update(original).digest('hex'),samples:[]};
for(const clip of clips){
  const wave=Buffer.alloc(44+clip.samples.length*2);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(rate,24);wave.writeUInt32LE(rate*2,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(clip.samples.length*2,40);
  clip.samples.forEach((value,i)=>{const fade=Math.min(1,i/(rate*.0005),(clip.samples.length-1-i)/(rate*.025));wave.writeInt16LE(Math.round(value/peak*.8*fade*32767),44+i*2);});
  const file=clip.name+'.wav';await writeFile(new URL(file,out),wave);manifest.samples.push({file,sourceStartSeconds:clip.start/rate,durationSeconds:.23,sha256:createHash('sha256').update(wave).digest('hex'),bytes:wave.length});
}
await writeFile(new URL('sources.json',out),JSON.stringify(manifest,null,2)+'\n');
await writeFile(new URL('LICENSE.txt',out),await readFile(new URL('../fretboard/samples/acoustic/LICENSE.txt',import.meta.url)));
console.log('Prepared two real pendulum metronome clicks (44 KB total).');
