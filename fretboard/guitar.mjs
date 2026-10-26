// Original Meta Creative Audio CC0 recordings, loaded one note at a time.
export const GUITAR_TOUCHES={steel:['Soft pluck','Medium pluck','Firm pluck'],nylon:['Fingerstyle','Light pick','Firm pick']};
export const guitarVoiceLabel=s=>`${s.guitarSound==='nylon'?'Nylon':'Steel-string'} · ${GUITAR_TOUCHES[s.guitarSound][s.guitarTouch-1].toLowerCase()}`;
const MIN=[64,59,55,50,45,40],MAX={steel:[84,79,75,70,65,60],nylon:[83,77,73,68,63,59]};

export function guitarSample({midi,string,kind='steel',layer=2}){
  if(!Number.isInteger(midi)||!Number.isInteger(string)||string<1||string>6||!MAX[kind]||![1,2,3].includes(layer)||midi<MIN[string-1]||midi>MIN[string-1]+24)throw Error('Invalid guitar position.');
  let root=Math.min(midi,MAX[kind][string-1]);
  if(kind==='steel'&&string===6&&root===47)root=48; // This one source position is absent.
  return {midi,string,kind,layer,root,semitones:midi-root,rate:2**((midi-root)/12),file:`${kind}/s${string}-${root}-v${layer}.ogg`};
}

export class SampledGuitar {
  buffers=new Map();pending=new Map();voices=new Set();strings=new Map();
  constructor(context,destination){
    this.context=context;this.bus=context.createGain();this.bus.gain.value=.75;
    this.compressor=context.createDynamicsCompressor();this.compressor.threshold.value=-8;this.compressor.knee.value=9;this.compressor.ratio.value=3;this.compressor.attack.value=.004;this.compressor.release.value=.15;
    this.bus.connect(this.compressor);this.compressor.connect(destination);
  }
  setVolume(value){this.bus.gain.setTargetAtTime(Math.max(0,Math.min(100,value))/100,this.context.currentTime,.015);}
  async prepare(position){
    const sample=guitarSample(position),file=sample.file;
    if(!this.buffers.has(file)){
      if(!this.pending.has(file)){
        const loading=(async()=>{
          const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
          try{
            const response=await fetch(new URL(`./samples/guitar/${file}`,import.meta.url),{signal:controller.signal});
            if(!response.ok)throw Error('Missing recording');
            const buffer=await this.context.decodeAudioData(await response.arrayBuffer());
            this.buffers.set(file,buffer);
            // Bound decoded audio memory; the browser can still cache the original files.
            while(this.buffers.size>24)this.buffers.delete(this.buffers.keys().next().value);
            return buffer;
          }catch{throw Error('Guitar recording could not load. Press Hear to retry.');}
          finally{clearTimeout(timer);this.pending.delete(file);}
        })();
        this.pending.set(file,loading);
      }
      const buffer=await this.pending.get(file);return {...sample,buffer};
    }
    const buffer=this.buffers.get(file);this.buffers.delete(file);this.buffers.set(file,buffer);
    return {...sample,buffer};
  }
  release(voice,time=this.context.currentTime){
    if(!voice||voice.released)return;voice.released=true;
    voice.gain.gain.cancelScheduledValues(time);voice.gain.gain.setValueAtTime(voice.time>time?0:voice.level,time);voice.gain.gain.linearRampToValueAtTime(0,time+.06);
    voice.source.stop(time+.065);this.voices.delete(voice);if(this.strings.get(voice.string)===voice)this.strings.delete(voice.string);
  }
  play(sample,time=this.context.currentTime){
    const source=this.context.createBufferSource(),gain=this.context.createGain();source.buffer=sample.buffer;source.playbackRate.value=sample.rate;
    this.release(this.strings.get(sample.string),time);
    // Keep the recorded attack and full decay. No pitch randomization in an ear-training tool.
    const level=2.2;gain.gain.setValueAtTime(0,time);gain.gain.linearRampToValueAtTime(level,time+.002);
    const end=time+sample.buffer.duration/sample.rate;gain.gain.setValueAtTime(level,Math.max(time+.002,end-.04));gain.gain.linearRampToValueAtTime(0,end);
    source.connect(gain);gain.connect(this.bus);
    const voice={...sample,source,gain,level,time,released:false};this.voices.add(voice);this.strings.set(sample.string,voice);
    source.onended=()=>{this.voices.delete(voice);if(this.strings.get(sample.string)===voice)this.strings.delete(sample.string);source.disconnect();gain.disconnect();};source.start(time);return voice;
  }
  stop(){for(const voice of [...this.voices])this.release(voice);}
}
