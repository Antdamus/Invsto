// Vendor the original CC0 web recordings, with pinned provenance and upstream hashes.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const revision='251c0be57d5d1b3242b91f53e0cde62ab1cb42d9';
const base=`https://raw.githubusercontent.com/facebookincubator/Meta-open-sound/${revision}/systems/instruments/`;
const out=new URL('../fretboard/samples/guitar/',import.meta.url);
const hash=data=>createHash('sha256').update(data).digest('hex');
async function fetchBytes(url){
  for(let attempt=0;attempt<3;attempt++)try{
    const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(`${response.status}: ${url}`);return Buffer.from(await response.arrayBuffer());
  }catch(error){if(attempt===2)throw error;}
}
const strings={HighE:1,B:2,G:3,D:4,A:5,LowE:6},naturals={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
await mkdir(out,{recursive:true});
for(const kind of ['steel','nylon']){
  const collection=`meta-${kind}-guitar`,url=base+collection+'/',folder=new URL(kind+'/',out);await mkdir(folder,{recursive:true});
  const metadata=JSON.parse(await fetchBytes(url+'manifest.json'));
  if(metadata.license!=='CC0-1.0')throw Error('Unexpected license');
  const checksumText=(await fetchBytes(url+'SHA256SUMS')).toString();
  const checksums=new Map(checksumText.trim().split(/\r?\n/).map(line=>{const [digest,path]=line.trim().split(/\s+/,2);return [path.replace(/^\*?\.\//,''),digest];}));
  const entries=metadata.samples.map(s=>{
    const m=s.file.match(/^INSGuitar(?:Steel|Nylon)_String(HighE|LowE|[ABDG])_Vel0([123])(?:Finger|Pick)?_([A-G])(s?)(\d)_01\.wav$/);
    if(!m)throw Error(`Unrecognized sample ${s.file}`);
    const string=strings[m[1]],layer=Number(m[2]),midi=12*(Number(m[5])+1)+naturals[m[3]]+(m[4]?1:0);
    const original=s.file.replace(/\.wav$/,'.ogg'),sha256=checksums.get('ogg/'+original)||checksums.get(original);
    if(!sha256)throw Error(`Missing upstream checksum ${original}`);
    return {file:`${kind}/s${string}-${midi}-v${layer}.ogg`,string,midi,layer,source:url+'ogg/'+original,sha256};
  });
  let cursor=0,done=0;
  await Promise.all(Array.from({length:6},async()=>{
    while(cursor<entries.length){
      const entry=entries[cursor++],dest=new URL(entry.file,out);let data;
      try{data=await readFile(dest);}catch{}
      if(!data||hash(data)!==entry.sha256){data=await fetchBytes(entry.source);if(hash(data)!==entry.sha256)throw Error(`Checksum mismatch ${entry.file}`);await writeFile(dest,data);}
      entry.bytes=data.length;if(++done%75===0)console.log(`${kind}: ${done}/${entries.length} verified recordings`);
    }
  }));
  await writeFile(new URL('LICENSE.txt',folder),await fetchBytes(url+'LICENSE'));
  await writeFile(new URL(`sources-${kind}.json`,out),JSON.stringify({library:metadata.name,author:'Meta Creative Audio',license:metadata.license,revision,source:base+collection,samples:entries},null,2)+'\n');
  console.log(`${kind}: ${entries.length} original OGG recordings, ${(entries.reduce((n,e)=>n+e.bytes,0)/1024/1024).toFixed(2)} MiB`);
}
