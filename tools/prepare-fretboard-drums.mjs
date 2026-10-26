// Rebuild the small browser kit from Karoryfer's CC0 recordings. Requires ffmpeg.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const revision='f07ce00df34a46b6b08375be56fe116cf15782bc';
const base=`https://raw.githubusercontent.com/sfzinstruments/karoryfer.big-rusty-drums/${revision}/`;
const out=new URL('../fretboard/samples/acoustic/',import.meta.url),temp=new URL('../test-results/drum-source/',import.meta.url);
await mkdir(out,{recursive:true});await mkdir(temp,{recursive:true});
const pieces=[
  ['kick','kick_24/kick','kick','k',{soft:7,hard:12},.9],
  ['snare','snare_14/center','top','sn_center',{soft:4,hard:9},.8],
  ['hat','hihat_14/cl','cl','ht_cl',{soft:3,hard:6},.45],
  ['openhat','hihat_14/ho','cl','ht_ho',{hard:3},.45],
  ['tomhi','tom_14/center','cl','t14',{hard:5},.8],
  ['tommid','tom_15/center','cl','t15',{hard:6},.8],
  ['tomlow','tom_18/center','cl','t18',{hard:6},.8],
  ['ride','ride_22/rd','cl','rd',{hard:7},.48],
  ['crash','crash_17/cr','cl','cr',{hard:4},.55],
];
async function download(path,dest){
  for(let attempt=0;attempt<3;attempt++)try{
    const response=await fetch(base+path,{signal:AbortSignal.timeout(25000)});
    if(!response.ok)throw Error(`${response.status}: ${path}`);
    const data=Buffer.from(await response.arrayBuffer());await writeFile(dest,data);return createHash('sha256').update(data).digest('hex');
  }catch(error){if(attempt===2)throw error;}
}
function convert(args){const r=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error(r.stderr||r.error?.message);}
function inspect(wav){
  let data;for(let at=12;at+8<wav.length;){const size=wav.readUInt32LE(at+4);if(wav.toString('ascii',at,at+4)==='data'){data=wav.subarray(at+8,at+8+size);break;}at+=8+size+(size%2);}
  if(!data)throw Error('Missing WAV audio');let peak=0;for(let i=0;i<data.length;i+=2)peak=Math.max(peak,Math.abs(data.readInt16LE(i))/32768);
  let first=0;while(first+4<data.length&&Math.max(Math.abs(data.readInt16LE(first)),Math.abs(data.readInt16LE(first+2)))/32768<peak*.01)first+=4;
  return {peak,trim:Math.max(0,Math.min(.1,first/4/44100)-.001)};
}
const manifest=[];
for(const [name,folder,mic,prefix,layers,target] of pieces){
  const mixes=[];
  for(const [layer,velocity] of Object.entries(layers))for(const rr of [1,2]){
    const filename=`${name}-${layer}-${rr}.wav`,stem=`${prefix}_vl${velocity}_rr${rr}.flac`;
    const inputs=[`Samples/${folder}/${mic}/${stem}`,`Samples/${folder}/oh/${stem}`];
    const paths=inputs.map((_,i)=>new URL(`${name}-${layer}-${rr}-${i}.flac`,temp));
    const hashes=await Promise.all(inputs.map((path,i)=>download(path,paths[i])));
    const mixed=new URL(`mix-${filename}`,temp);
    convert(['-i',fileURLToPath(paths[0]),'-i',fileURLToPath(paths[1]),'-filter_complex','[0:a]aformat=channel_layouts=stereo[a];[1:a]aformat=channel_layouts=stereo,volume=0.3[b];[a][b]amix=inputs=2:normalize=0','-ar','44100','-c:a','pcm_s16le',fileURLToPath(mixed)]);
    const info=inspect(await readFile(mixed));mixes.push({filename,mixed,...info,inputs,hashes});
  }
  const maximum=Math.max(...mixes.map(x=>x.peak));
  for(const m of mixes){
    convert(['-i',fileURLToPath(m.mixed),'-af',`atrim=start=${m.trim},asetpts=PTS-STARTPTS,volume=${target/maximum}`,'-ar','44100','-c:a','pcm_s16le',fileURLToPath(new URL(m.filename,out))]);
    const data=await readFile(new URL(m.filename,out));manifest.push({file:m.filename,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),sources:m.inputs.map((path,i)=>({url:base+path,sha256:m.hashes[i]})),trimSeconds:m.trim,gain:target/maximum});
  }
  console.log(`Prepared ${name}: ${mixes.length} recordings`);
}
await download('LICENSE',new URL('LICENSE.txt',out));
await writeFile(new URL('sources.json',out),JSON.stringify({library:'Big Rusty Drums',author:'Karoryfer Samples',license:'CC0-1.0',revision,samples:manifest},null,2)+'\n');
console.log(`${manifest.length} stereo WAVs, ${(manifest.reduce((n,s)=>n+s.bytes,0)/1024/1024).toFixed(2)} MiB`);
