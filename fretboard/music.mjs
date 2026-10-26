export const TUNING = [64, 59, 55, 50, 45, 40]; // Strings 1–6, sounding MIDI pitches.
export const ROOTS = ['C','D♭','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
export const SCALES = {
  major: {name:'Major', intervals:[0,2,4,5,7,9,11], degrees:[0,1,2,3,4,5,6]},
  minor: {name:'Natural minor', intervals:[0,2,3,5,7,8,10], degrees:[0,1,2,3,4,5,6]},
  pentatonic: {name:'Minor pentatonic', intervals:[0,3,5,7,10], degrees:[0,2,3,4,6]},
  chromatic: {name:'All 12 notes', intervals:[0,1,2,3,4,5,6,7,8,9,10,11]}
};
export const DEFAULTS = {root:0,scale:'major',pool:[0],octaves:[2,3,4,5,6],strings:[1,2,3,4,5,6],minFret:0,maxFret:21,bpm:60,duration:2,mode:'timed',hints:true,autoAdd:false,targetBpm:100,loop:true,metronome:true,headphones:false,backing:'off',volume:35,goal:5,drums:'off',drumVolume:65,drumFills:true};
export const mod = (n,m=12) => ((n%m)+m)%m;
export const frequency = midi => 440*2**((midi-69)/12);
export const octave = midi => Math.floor(midi/12)-1;
export function scalePCs(s) {return SCALES[s.scale].intervals.map(n=>mod(n+s.root));}
export function spell(midi,s=DEFAULTS) {
  const pc=mod(midi), scale=SCALES[s.scale], degree=scalePCs(s).indexOf(pc);
  const letters='CDEFGAB', naturals=[0,2,4,5,7,9,11];
  let letter,acc;
  if(scale.degrees && degree>=0){
    const rootLetter=letters.indexOf(ROOTS[s.root][0]);
    letter=letters[(rootLetter+scale.degrees[degree])%7];
    acc=mod(pc-naturals[letters.indexOf(letter)]+6)-6;
  }else{
    const names=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
    letter=names[pc][0];acc=names[pc].length>1?1:0;
  }
  const oct=(midi-naturals[letters.indexOf(letter)]-acc)/12-1;
  return {letter,acc,oct,name:letter+accidental(acc)+oct,step:oct*7+letters.indexOf(letter)};
}
export function accidental(n){return n===0?'':n>0?'♯'.repeat(n):'♭'.repeat(-n);}
export function noteName(midi,s){return spell(midi,s).name;}
export function positions(s,ignorePool=false){
  const result=[];
  TUNING.forEach((base,i)=>{
    if(!s.strings.includes(i+1))return;
    for(let fret=s.minFret;fret<=s.maxFret;fret++){
      const midi=base+fret;
      if(s.octaves.includes(octave(midi))&&(ignorePool||s.pool.includes(mod(midi))))result.push({string:i+1,fret,midi});
    }
  });return result;
}
export function makeScore(s,random=Math.random,usage={}){
  const places=positions(s),pitches=[...new Set(places.map(p=>p.midi))];
  if(!pitches.length)return [];
  const count=16/s.duration,result=[],counts={...usage};let deck=[];
  for(let i=0;i<count;i++){
    if(!deck.length){deck=[...pitches];for(let j=deck.length-1;j>0;j--){const k=Math.floor(random()*(j+1));[deck[j],deck[k]]=[deck[k],deck[j]];}if(deck.length>1&&deck.at(-1)===result.at(-1)?.midi)[deck[0],deck[deck.length-1]]=[deck.at(-1),deck[0]];}
    const midi=deck.pop(),options=places.filter(p=>p.midi===midi),min=Math.min(...options.map(p=>counts[p.string+':'+p.fret]||0)),fresh=options.filter(p=>(counts[p.string+':'+p.fret]||0)===min),position=fresh[Math.floor(random()*fresh.length)];
    counts[position.string+':'+position.fret]=(counts[position.string+':'+position.fret]||0)+1;
    result.push({midi,position,beat:i*s.duration,duration:s.duration});
  }return result;
}
export function masteryFor(midi,progress,s){
  const passes=(progress.notes?.[midi]?.passes||[]).filter(p=>p.bpm>=s.targetBpm&&p.duration===s.duration&&!p.hints);
  return {ready:passes.length>=2&&passes.reduce((n,p)=>n+p.hits,0)>=4,passes:passes.length,hits:passes.reduce((n,p)=>n+p.hits,0)};
}
export function recommendation(s,progress){
  const active=[...new Set(positions(s).map(p=>p.midi))];
  const weak=active.filter(m=>!masteryFor(m,progress,s).ready).sort((a,b)=>{
    const x=progress.notes?.[a]||{},y=progress.notes?.[b]||{};
    return ((x.correct||0)/Math.max(1,x.attempts||0))-((y.correct||0)/Math.max(1,y.attempts||0))||(x.last||0)-(y.last||0);
  });
  const available=positions(s,true).filter(p=>scalePCs(s).includes(mod(p.midi))&&!s.pool.includes(mod(p.midi)));
  const mastered=active.filter(m=>masteryFor(m,progress,s).ready),anchors=mastered.length?mastered:active;
  available.sort((a,b)=>Math.min(...anchors.map(m=>Math.abs(a.midi-m)))-Math.min(...anchors.map(m=>Math.abs(b.midi-m)))||a.fret-b.fret);
  const next=available[0];
  return {weak:weak[0]??null,next:next?mod(next.midi):nextPitchClass(s),example:next?.midi,ready:active.length>0&&!weak.length,mastered:mastered.length,total:active.length};
}
export function nextPitchClass(s){
  const pcs=scalePCs(s),start=pcs.indexOf(s.pool[0]);
  for(let i=1;i<=pcs.length;i++){const pc=pcs[mod(start+i,pcs.length)];if(!s.pool.includes(pc))return pc;}
  return null;
}
export function pitchMatch(midi,frequencyHz,tolerance=35){
  if(!Number.isFinite(frequencyHz)||frequencyHz<=0)return {correct:false,heard:null,cents:null};
  const fractional=69+12*Math.log2(frequencyHz/440),heard=Math.round(fractional),cents=100*(fractional-midi);
  return {correct:Math.abs(cents)<=tolerance,heard,cents,octaveError:heard!==midi&&mod(heard)===mod(midi)};
}
export function timingGrade(offsetSeconds,beatSeconds){
  return Math.abs(offsetSeconds)<=Math.min(.22,beatSeconds*.3)?'On time':offsetSeconds<0?'Early':'Late';
}
// YIN difference function: the first strong periodic minimum avoids harmonic octave matches.
export function detectPitch(samples,sampleRate){
  let energy=0,mean=0;for(const x of samples)mean+=x;mean/=samples.length;
  for(const x of samples)energy+=(x-mean)**2;
  if(Math.sqrt(energy/samples.length)<.008)return null;
  const maxLag=Math.min(Math.floor(sampleRate/65),Math.floor(samples.length/2)),minLag=Math.floor(sampleRate/1500);
  const diff=new Float64Array(maxLag+1),window=samples.length-maxLag;
  for(let tau=1;tau<=maxLag;tau++){let sum=0;for(let j=0;j<window;j++){const d=samples[j]-samples[j+tau];sum+=d*d;}diff[tau]=sum;}
  let sum=0;diff[0]=1;
  for(let tau=1;tau<=maxLag;tau++){sum+=diff[tau];diff[tau]=sum?diff[tau]*tau/sum:1;}
  for(let tau=Math.max(2,minLag);tau<maxLag-1;tau++){
    if(diff[tau]<.13){
      while(tau+1<maxLag&&diff[tau+1]<diff[tau])tau++;
      const a=diff[tau-1],b=diff[tau],c=diff[tau+1],denom=2*(2*b-c-a);
      const refined=tau+(denom?(c-a)/denom:0);
      return {frequency:sampleRate/refined,confidence:1-b,rms:Math.sqrt(energy/samples.length)};
    }
  }return null;
}
export function sanitizeSettings(value={}){
  const s={...DEFAULTS},num=(key,min,max)=>{const n=Number(value[key]);if(Number.isFinite(n))s[key]=Math.max(min,Math.min(max,n));};
  num('root',0,11);s.root=Math.round(s.root);
  if(SCALES[value.scale])s.scale=value.scale;
  for(const [key,allowed] of [['pool',scalePCs(s)],['octaves',[2,3,4,5,6]],['strings',[1,2,3,4,5,6]]]){
    if(Array.isArray(value[key])){const a=[...new Set(value[key].filter(x=>allowed.includes(x)))];if(a.length)s[key]=a;}
  }
  s.pool=s.pool.filter(pc=>scalePCs(s).includes(pc));if(!s.pool.length)s.pool=[s.root];
  num('minFret',0,24);num('maxFret',0,24);s.minFret=Math.round(s.minFret);s.maxFret=Math.max(s.minFret,Math.round(s.maxFret));
  num('bpm',35,180);num('targetBpm',35,180);num('volume',0,70);num('goal',0,60);num('drumVolume',0,100);
  if([1,2,4].includes(value.duration))s.duration=value.duration;
  if(['timed','wait'].includes(value.mode))s.mode=value.mode;
  if(['off','drone','groove','upload'].includes(value.backing))s.backing=value.backing;
  if(['off','pop','rock','shuffle','halftime'].includes(value.drums))s.drums=value.drums;
  for(const k of ['hints','autoAdd','loop','metronome','headphones','drumFills'])if(typeof value[k]==='boolean')s[k]=value[k];
  return s;
}
