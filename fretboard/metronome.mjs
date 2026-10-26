export class PendulumMetronome {
  buffers=new Map();voices=new Set();loading=null;
  constructor(context,destination){this.context=context;this.bus=context.createGain();this.bus.gain.value=.75;this.bus.connect(destination);}
  setVolume(value=75){this.bus.gain.setTargetAtTime(value/100,this.context.currentTime,.01);}
  async load(){
    if(this.buffers.size===2)return;if(this.loading)return this.loading;
    this.loading=(async()=>{
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
      try{
        const results=await Promise.allSettled(['tick','tock'].map(async name=>{
          const response=await fetch(new URL(`./samples/metronome/${name}.wav`,import.meta.url),{signal:controller.signal});
          if(!response.ok)throw Error('Metronome recording unavailable');
          return [name,await this.context.decodeAudioData(await response.arrayBuffer())];
        }));
        if(results.some(r=>r.status==='rejected'))throw Error('Metronome recording unavailable');
        for(const result of results)this.buffers.set(...result.value);
      }finally{clearTimeout(timeout);}
    })();
    try{await this.loading;}finally{this.loading=null;}
  }
  beat(time,beat,settings){
    const accent=settings.metronomeAccent!==false&&beat%4===0;
    const name=beat%2===0?'tick':'tock',mechanical=settings.metronomeSound!=='digital'&&this.buffers.size===2;
    const context=this.context,gain=context.createGain();this.setVolume(settings.metronomeVolume);
    let source;
    if(mechanical){
      source=context.createBufferSource();source.buffer=this.buffers.get(name);gain.gain.setValueAtTime(accent?1:.7,time);
    }else{
      // Built-in alternative also keeps practice usable if recorded audio cannot load.
      source=context.createOscillator();source.type='sine';source.frequency.value=accent?1760:1174.66;
      gain.gain.setValueAtTime(0,time);gain.gain.linearRampToValueAtTime(accent?.25:.18,time+.002);gain.gain.exponentialRampToValueAtTime(.0001,time+.05);
    }
    source.connect(gain);gain.connect(this.bus);this.voices.add(source);
    source.onended=()=>{this.voices.delete(source);source.disconnect();gain.disconnect();};source.start(time);if(!mechanical)source.stop(time+.06);
  }
  stop(){for(const voice of this.voices){try{voice.stop();}catch{}}this.voices.clear();}
}
