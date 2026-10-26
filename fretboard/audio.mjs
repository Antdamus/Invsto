import {frequency,detectPitch} from './music.mjs';
export class StudioAudio {
  context=null;voices=new Set();stream=null;analyser=null;micTimer=null;micGeneration=0;muted=false;
  async init(){if(!this.context){const C=window.AudioContext||window.webkitAudioContext;if(!C)throw Error('Audio is not supported in this browser.');this.context=new C();this.master=this.context.createGain();this.master.gain.value=.35;this.master.connect(this.context.destination);}await this.context.resume();return this.context;}
  setVolume(value){if(this.master)this.master.gain.value=this.muted?0:value/100;}
  tone(midi,time,length=.5,gain=.2,type='triangle'){
    if(!this.context||this.muted)return;
    const o=this.context.createOscillator(),g=this.context.createGain();o.type=type;o.frequency.value=frequency(midi);
    g.gain.setValueAtTime(0,time);g.gain.linearRampToValueAtTime(gain,time+.009);g.gain.exponentialRampToValueAtTime(.0001,time+length);
    o.connect(g);g.connect(this.master);o.start(time);o.stop(time+length+.02);this.voices.add(o);o.onended=()=>{this.voices.delete(o);o.disconnect();g.disconnect();};
  }
  beat(time,beat,s){
    if(s.metronome||beat<0)this.tone(beat%4===0?94:87,time,.045,.18,'sine');
    if(beat<0||s.backing==='off'||s.backing==='upload')return;
    const duration=60/s.bpm,root=36+s.root;
    if(s.backing==='drone'&&beat%4===0){this.tone(root,time,duration*3.8,.16,'sine');this.tone(root+7,time,duration*3.8,.07,'sine');}
    if(s.backing==='groove'){
      // Tonic + fifth works with major, minor and minor pentatonic note pools.
      this.tone(root+(beat%4===2?7:0),time,duration*.7,.28,'triangle');
      if(beat%2===1)this.tone(78,time,.035,.045,'triangle');
      if(beat%4===0){this.tone(root+12,time,duration*3,.065,'sine');this.tone(root+19,time,duration*3,.045,'sine');}
    }
  }
  stopVoices(){for(const voice of this.voices){try{voice.stop();}catch{}}this.voices.clear();}
  async startMic(onPitch){
    const generation=++this.micGeneration;
    if(!navigator.mediaDevices?.getUserMedia)throw Error('Microphone needs HTTPS or localhost and a supported browser. Manual practice still works.');
    await this.init();
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    if(generation!==this.micGeneration){stream.getTracks().forEach(t=>t.stop());return false;}
    this.stream=stream;this.source=this.context.createMediaStreamSource(stream);this.analyser=this.context.createAnalyser();this.analyser.fftSize=4096;this.source.connect(this.analyser);
    this.muted=true;this.master.gain.value=0;this.stopVoices();const data=new Float32Array(4096);
    this.micTimer=setInterval(()=>{this.analyser.getFloatTimeDomainData(data);onPitch(detectPitch(data,this.context.sampleRate));},80);
    stream.getAudioTracks()[0].onended=()=>{this.stopMic();onPitch({ended:true});};return true;
  }
  stopMic(){this.micGeneration++;clearInterval(this.micTimer);this.micTimer=null;this.source?.disconnect();this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});this.stream=null;this.analyser=null;this.muted=false;}
}
