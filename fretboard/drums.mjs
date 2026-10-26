// A compact acoustic kit made from recorded hits, not synthesized percussion.
export const DRUM_STYLES=['off','pop','rock','shuffle','halftime'];
export const DRUM_PIECES=['kick','snare','hat','openhat','tomhi','tommid','tomlow','ride','crash'];
export const DRUM_FILES=DRUM_PIECES.flatMap(piece=>(['kick','snare','hat'].includes(piece)?['soft','hard']:['hard']).flatMap(layer=>[1,2].map(rr=>`${piece}-${layer}-${rr}.wav`)));

// Offsets are in beats: changing tempo changes spacing, never sample pitch.
export function drumHits(beat,style='pop',fills=true){
  if(beat<0||!DRUM_STYLES.includes(style)||style==='off')return [];
  const b=beat%4,phrase=beat%16,hits=[];
  const add=(piece,offset,velocity)=>hits.push({piece,offset,velocity});
  if(b===0||b===2&&style!=='halftime')add('kick',0,style==='rock'?.95:.82);
  if(style==='halftime'&&b===3)add('kick',.5,.65);
  if(style==='rock'&&b===2||style==='pop'&&phrase===6)add('kick',.5,.72);
  if(fills&&phrase===0)add('crash',0,.72);
  if(fills&&phrase>=14){
    if(phrase===14){add('snare',0,.78);add('tomhi',.5,.72);add('tomhi',.75,.85);}
    else{add('tommid',0,.82);add('tommid',.25,.7);add('tomlow',.5,.85);add('tomlow',.75,.95);}
  }else{
    if(style==='halftime'?b===2:b===1||b===3)add('snare',0,style==='rock'?.96:.82);
    const cymbal=style==='shuffle'?'ride':'hat';
    add(cymbal,0,b%2===0?.78:.66);
    add(style==='rock'&&b===3?'openhat':cymbal,style==='shuffle'?2/3:.5,.48);
    if(style==='pop'&&phrase===11)add('snare',.75,.35);
  }
  return hits.sort((a,b)=>a.offset-b.offset);
}

export class AcousticKit {
  buffers=new Map();voices=new Set();roundRobin=new Map();loading=null;ready=false;
  constructor(context,destination){
    this.context=context;this.bus=context.createGain();this.bus.gain.value=.65;
    // Gentle peak control leaves the acoustic decay and stereo room intact.
    this.compressor=context.createDynamicsCompressor();this.compressor.threshold.value=-10;this.compressor.knee.value=10;this.compressor.ratio.value=3;this.compressor.attack.value=.003;this.compressor.release.value=.15;
    this.bus.connect(this.compressor);this.compressor.connect(destination);
  }
  setVolume(value){this.bus.gain.setTargetAtTime(value/100,this.context.currentTime,.015);}
  async load(){
    if(this.ready)return;if(this.loading)return this.loading;
    this.loading=(async()=>{
      const queue=DRUM_FILES.filter(file=>!this.buffers.has(file)),controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),30000);
      try{
        const results=await Promise.allSettled(Array.from({length:4},async()=>{
          try{while(queue.length){
            const file=queue.shift(),response=await fetch(new URL(`./samples/acoustic/${file}`,import.meta.url),{signal:controller.signal});
            if(!response.ok)throw Error(`Could not load ${file}`);
            const buffer=await this.context.decodeAudioData(await response.arrayBuffer());this.buffers.set(file,buffer);
          }}catch(error){controller.abort();throw error;}
        }));
        if(results.some(r=>r.status==='rejected'))throw Error('The acoustic kit could not load. Retry, or choose Drums off to keep practicing.');
        this.ready=true;
      }finally{clearTimeout(timeout);}
    })();
    try{await this.loading;}finally{this.loading=null;}
  }
  hit(piece,time,velocity=.8){
    if(!this.ready)return;
    const layer=velocity<.67&&['kick','snare','hat'].includes(piece)?'soft':'hard',key=`${piece}-${layer}`;
    const rr=(this.roundRobin.get(key)||0)%2+1;this.roundRobin.set(key,rr);
    const buffer=this.buffers.get(`${key}-${rr}.wav`);if(!buffer)return;
    const context=this.context,source=context.createBufferSource(),gain=context.createGain();source.buffer=buffer;
    // Different takes + restrained touch variation. Beat onsets stay exact.
    const level=velocity*(.96+Math.random()*.08);gain.gain.setValueAtTime(level,time);
    if(piece==='hat'||piece==='openhat')for(const voice of this.voices){
      if((voice.piece==='hat'||voice.piece==='openhat')&&voice.time<=time&&(!voice.chokedAt||time<voice.chokedAt)){
        voice.chokedAt=time;
        voice.gain.gain.cancelScheduledValues(time);voice.gain.gain.setValueAtTime(voice.level,time);voice.gain.gain.linearRampToValueAtTime(0,time+.018);voice.source.stop(time+.02);
      }
    }
    source.connect(gain);gain.connect(this.bus);
    const voice={source,gain,piece,time,level};this.voices.add(voice);
    source.onended=()=>{this.voices.delete(voice);source.disconnect();gain.disconnect();};source.start(time);
  }
  beat(time,beat,settings){
    this.setVolume(settings.drumVolume);
    for(const hit of drumHits(beat,settings.drums,settings.drumFills))this.hit(hit.piece,time+hit.offset*60/settings.bpm,hit.velocity);
  }
  stop(){
    const now=this.context.currentTime;
    for(const voice of this.voices){try{
      voice.gain.gain.cancelScheduledValues(now);voice.gain.gain.setValueAtTime(voice.time>now?0:voice.level,now);voice.gain.gain.linearRampToValueAtTime(0,now+.01);voice.source.stop(now+.012);
    }catch{}}
    this.voices.clear();
  }
}
