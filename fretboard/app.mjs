import {TUNING,ROOTS,SCALES,DEFAULTS,mod,frequency,octave,spell,noteName,positions,makeScore,scalePCs,sanitizeSettings,pitchMatch,timingGrade,recommendation,masteryFor} from './music.mjs?v=5';
import {StudioAudio} from './audio.mjs?v=5';
import {createNoteMap} from './note-map.mjs?v=4';
import {GUITAR_TOUCHES,guitarVoiceLabel} from './guitar.mjs?v=1';
import {needsStringNumber,stringMarkerY} from './notation.mjs?v=2';
const $=id=>document.getElementById(id),audio=new StudioAudio(),STORE='fretwise.v1';
let saved={};try{saved=JSON.parse(localStorage.getItem(STORE)||'{}')||{};}catch{}
let settings=sanitizeSettings(saved.settings),progress={sessions:[],notes:{},positionUse:{},...saved.progress};
if(!Array.isArray(progress.sessions))progress.sessions=[];
if(!progress.notes||typeof progress.notes!=='object')progress.notes={};
if(!progress.positionUse||typeof progress.positionUse!=='object')progress.positionUse={};
let score=[],results=[],active=0,running=false,starting=false,finished=false,revealed=false,micOn=false,micPending=false;
let position=-4,phaseTime=0,phaseOffset=-4,nextBeat=-4,raf=0,scheduler=0,runStarted=0,practiceMs=0,sessionSaved=false;
let stats={correct:0,wrong:0,missed:0,streak:0,best:0,onTime:0,manual:0},cleanPasses=0,noticeTimeout,waitAdvance=0,trackURL=null;
let micPitch=null,micSince=0,micOnset=0,micLatched=false,lastRms=0,lastAttack=0;
let metronomeState='idle',metronomePreviewTimer=0;
let startGeneration=0,drumState='idle',previewTimer=0,previewGeneration=0;
let guitarStatus='Recordings load when you press Hear.',guitarRequest=0;
const secondsPerBeat=()=>60/settings.bpm;
const audible=()=>!micOn||settings.headphones;
const currentEvent=()=>score[active];
const elapsed=()=>practiceMs+(running?performance.now()-runStarted:0);
const clockText=ms=>`${String(Math.floor(ms/60000)).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
const pitchClassName=pc=>spell(60+pc,settings).name.replace(/-?\d+$/,'');
function persist(){try{localStorage.setItem(STORE,JSON.stringify({settings,progress}));}catch{notice('Storage is unavailable. You can keep practicing, but progress will not be saved.');}}
function notice(message){$('notice').textContent=message;$('notice').classList.add('visible');clearTimeout(noticeTimeout);noticeTimeout=setTimeout(()=>$('notice').classList.remove('visible'),5000);}
function setCue(message,detail=''){$('cue-message').textContent=message;$('cue-detail').textContent=detail;}
function setupControls(){
  $('root').innerHTML=ROOTS.map((n,i)=>`<option value="${i}">${n}</option>`).join('');
  $('scale').innerHTML=Object.entries(SCALES).map(([k,v])=>`<option value="${k}">${v.name}</option>`).join('');
  syncControls();
}
function syncControls(){
  for(const [id,key] of [['root','root'],['scale','scale'],['duration','duration'],['mode','mode'],['bpm','bpm'],['min-fret','minFret'],['max-fret','maxFret'],['target-bpm','targetBpm'],['backing','backing'],['volume','volume'],['goal','goal'],['drums','drums'],['drum-volume','drumVolume'],['metronome-sound','metronomeSound'],['metronome-volume','metronomeVolume']])$(id).value=settings[key];
  for(const [id,key] of [['hints','hints'],['auto-add','autoAdd'],['loop','loop'],['metronome','metronome'],['headphones','headphones'],['drum-fills','drumFills'],['metronome-accent','metronomeAccent']])$(id).checked=settings[key];
  $('start-note').innerHTML=scalePCs(settings).map(pc=>`<option value="${pc}">${pitchClassName(pc)} · all octaves in range</option>`).join('');$('start-note').value=settings.pool[0];
  $('note-palette').innerHTML=scalePCs(settings).map(pc=>`<button type="button" data-pc="${pc}" class="${settings.pool.includes(pc)?'selected':''}" aria-pressed="${settings.pool.includes(pc)}" aria-label="Include ${pitchClassName(pc)} in all selected octaves">${pitchClassName(pc)}</button>`).join('');
  $('pool-count').textContent=`${settings.pool.length} of ${scalePCs(settings).length}`;
  $('octaves').innerHTML=[2,3,4,5,6].map(o=>`<button type="button" data-octave="${o}" class="${settings.octaves.includes(o)?'selected':''}" aria-pressed="${settings.octaves.includes(o)}" aria-label="Sounding octave ${o}">${o}</button>`).join('');
  $('strings').innerHTML=TUNING.map((m,i)=>`<button type="button" data-string="${i+1}" class="${settings.strings.includes(i+1)?'selected':''}" aria-pressed="${settings.strings.includes(i+1)}" aria-label="String ${i+1}, ${noteName(m)}">${i+1} · ${ROOTS[mod(m)]}</button>`).join('');
  $('range-summary').textContent=`${settings.strings.length===6?'All strings':settings.strings.length+' strings'} · frets ${settings.minFret}–${settings.maxFret}`;
  $('upload-wrap').hidden=settings.backing!=='upload';$('user-track').volume=settings.volume/100;
  $('backing-help').textContent=settings.scale==='chromatic'?'Chromatic notes can clash with a fixed key. Use just your guitar, or a track you choose.':'A tonic + fifth accompaniment follows your key and tempo.';
  updateSoundControls();
  updateRecommendation();
}
function updateSoundControls(){
  $('guitar-sound').value=settings.guitarSound;
  $('guitar-touch').innerHTML=GUITAR_TOUCHES[settings.guitarSound].map((label,i)=>`<option value="${i+1}">${label}</option>`).join('');$('guitar-touch').value=settings.guitarTouch;
  $('guitar-volume').value=settings.guitarVolume;$('guitar-volume-value').textContent=`${settings.guitarVolume}%`;
  $('guitar-status').textContent=audible()?guitarStatus:'Muted while listening. Enable headphones to hear the guitar.';
  $('hear').disabled=!audible()||!currentEvent();
  $('drum-controls').hidden=settings.drums==='off';
  $('drum-volume-value').textContent=`${settings.drumVolume}%`;
  $('drum-retry').hidden=drumState!=='error'||settings.drums==='off';
  $('drum-status').textContent=settings.drums==='off'?'Recorded acoustic drums, ready when you are.':drumState==='loading'?'Loading 24 real drum recordings (18 MB)…':drumState==='error'?'Kit download failed. Retry, or switch drums off to practice.':!audible()?'Muted while listening. Enable headphones above to hear drums.':drumState==='ready'?`Acoustic kit ready · follows ${settings.bpm} BPM · 4/4`:'Loads when you press Play or Preview groove.';
  $('drum-preview').disabled=running||starting||!audible();
  $('metronome-preview').disabled=running||starting||!audible();
  $('metronome-volume-value').textContent=`${settings.metronomeVolume}%`;
  $('metronome-status').textContent=!audible()?'Muted while listening. Enable headphones to hear the metronome.':settings.metronomeSound==='digital'?'Electronic click · same tempo as your score.':metronomeState==='loading'?'Loading the recorded tick and tock…':metronomeState==='error'?'Recording unavailable; using a digital click. Press Preview to retry.':'Actual pendulum metronome recordings · alternating tick-tock.';
}
async function prepareDrums(){
  drumState='loading';updateSoundControls();
  try{await audio.loadDrums();audio.setVolume(settings.volume);drumState='ready';updateSoundControls();return true;}
  catch(error){drumState='error';updateSoundControls();notice(error.message);return false;}
}
async function prepareMetronome(){
  if(settings.metronomeSound==='digital')return;
  metronomeState='loading';updateSoundControls();
  try{await audio.loadMetronome();metronomeState='ready';}
  catch{metronomeState='error';}
  updateSoundControls();
}
async function previewMetronome(){
  if(metronomePreviewTimer||$('metronome-preview').dataset.loading==='true'){stopPreview();return;}
  if(running||starting||!audible())return;stopPreview();const generation=previewGeneration;
  $('metronome-preview').dataset.loading='true';$('metronome-preview').textContent='Cancel preview';
  try{await audio.init();audio.setVolume(settings.volume);await prepareMetronome();}
  catch{if(generation===previewGeneration){stopPreview();notice('Audio is unavailable in this browser.');}return;}
  if(generation!==previewGeneration)return;delete $('metronome-preview').dataset.loading;$('metronome-preview').textContent='■ Stop preview';
  const begins=audio.context.currentTime+.08;let next=0;
  const schedule=()=>{
    if(!audible()){stopPreview();return;}
    const now=audio.context.currentTime;
    while(next<4&&begins+next*secondsPerBeat()<now+.12){const time=begins+next*secondsPerBeat();if(time>=now-.04)audio.metronome.beat(time,next,settings);next++;}
    if(now>=begins+4*secondsPerBeat())stopPreview();
  };
  metronomePreviewTimer=setInterval(schedule,25);schedule();
}
function stopPreview(){
  audio.stopGuitar();
  previewGeneration++;clearInterval(previewTimer);previewTimer=0;clearInterval(metronomePreviewTimer);metronomePreviewTimer=0;audio.metronome?.stop();delete $('metronome-preview').dataset.loading;$('metronome-preview').textContent='▶ Preview metronome';delete $('drum-preview').dataset.loading;audio.drums?.stop();$('drum-preview').textContent='▶ Preview groove';
}
async function previewDrums(){
  if(previewTimer||$('drum-preview').dataset.loading==='true'){stopPreview();delete $('drum-preview').dataset.loading;return;}
  if(running||starting||!audible())return;stopPreview();const generation=previewGeneration;
  $('drum-preview').dataset.loading='true';$('drum-preview').textContent='Cancel preview';
  const ready=await prepareDrums();
  if(generation!==previewGeneration)return;delete $('drum-preview').dataset.loading;
  if(!ready){stopPreview();return;}
  $('drum-preview').textContent='■ Stop preview';
  const begins=audio.context.currentTime+.08;let next=0;
  const schedule=()=>{
    if(!audible()){stopPreview();return;}
    const now=audio.context.currentTime;
    while(next<16&&begins+next*secondsPerBeat()<now+.12){const time=begins+next*secondsPerBeat();if(time>=now-.04)audio.drums.beat(time,next,settings);next++;}
    if(now>=begins+16*secondsPerBeat())stopPreview();
  };
  previewTimer=setInterval(schedule,25);schedule();
}
function updateRecommendation(){
  const rec=recommendation(settings,progress);
  $('map-next').hidden=rec.next===null;
  $('map-next').textContent=rec.next===null?'':`Preview ${pitchClassName(rec.next)} on the map ↗`;
  $('add-note').disabled=running||rec.next===null;
  $('add-note').classList.toggle('ready',rec.ready);
  $('add-note').textContent=rec.next===null?'All notes in this family included':`＋ Add ${pitchClassName(rec.next)} · recommended next`;
  $('mastery-label').textContent=`${rec.mastered} / ${rec.total} pitches at goal`;
  $('mastery-help').textContent=rec.ready?'Ready for another note. Keep revisiting these pitches in later sessions.':`${rec.weak===null?'Each pitch':noteName(rec.weak,settings)}: 2 clean, unassisted passes and 4 correct notes at ${settings.targetBpm} BPM with this rhythm. ${settings.hints?'Turn hints off for a goal attempt.':'Manual checks are self-rated.'}`;
  $('mastery-dots').querySelectorAll('i').forEach((el,i)=>el.classList.toggle('done',cleanPasses>i));
}
function newScore(){
  clearTimeout(waitAdvance);score=makeScore(settings,Math.random,progress.positionUse);results=score.map(()=>null);active=0;finished=false;position=-4;phaseOffset=-4;revealed=false;
  $('phrase-title').textContent=settings.pool.length===1?`Meet ${pitchClassName(settings.pool[0])}, everywhere`:'A few notes. A little music.';
  $('scale-badge').textContent=`${ROOTS[settings.root]} ${SCALES[settings.scale].name.toLowerCase()}`;
  $('score-description').textContent=`4 bars · 4/4 · ${settings.duration===1?'quarter':settings.duration===2?'half':'whole'} notes`;
  renderScore();renderFretboard();showCurrent();setCue('Read it. Find it. Play it.','Press Play for a four-beat count-in.');
  $('play').disabled=!score.length;
  if(!score.length)setCue('No playable notes in this range.','Include another octave, string, or fret range.');
  updateSoundControls();
}
async function hearGuitar(position,isCurrent=()=>true,onStatus=()=>{}){
  if(!audible()||!isCurrent())return;
  const request=++guitarRequest,voiceSettings={...settings};guitarStatus='Loading guitar recording…';updateSoundControls();onStatus(guitarStatus);
  try{
    const sample=await audio.playGuitar(position,voiceSettings,()=>isCurrent()&&audible()&&!document.hidden);
    if(!sample){if(request===guitarRequest&&guitarStatus==='Loading guitar recording…'){guitarStatus='Recordings load when you press Hear.';updateSoundControls();}return;}
    audio.setVolume(settings.volume);
    const shift=sample.semitones?` · nearby recording adjusted ${sample.semitones>0?'+':''}${sample.semitones} ${Math.abs(sample.semitones)===1?'semitone':'semitones'}`:'';
    guitarStatus=`${guitarVoiceLabel(voiceSettings)} · ${noteName(sample.midi,settings)} on string ${sample.string}${shift}`;
    updateSoundControls();onStatus(guitarStatus);return guitarStatus;
  }catch(error){guitarStatus=error.message;updateSoundControls();onStatus(guitarStatus);throw error;}
}
function changeGuitarSound(key,value){audio.stopGuitar();settings[key]=value;guitarStatus='Recordings load when you press Hear.';updateSoundControls();persist();}
function renderScore(){
  if(!score.length){$('sheet').innerHTML='<div class="empty-score">No notes match this setup.<br>Widen your octave, string or fret range.</div>';return;}
  const ys=score.map(n=>128-(spell(n.midi+12,settings).step-30)*7),marks=ys.map(stringMarkerY);
  const hintYs=ys.map((y,i)=>marks[i]<y?marks[i]-16:marks[i]+25);
  const contentTop=Math.min(60,...ys.map((y,i)=>Math.min(y-(score[i].duration<4&&y>=100?40:9),marks[i]-10,settings.hints?hintYs[i]-13:Infinity)));
  const contentBottom=Math.max(162,...ys.map((y,i)=>Math.max(y+(score[i].duration<4&&y<100?40:9),marks[i]+10,settings.hints?hintYs[i]+3:-Infinity)));
  const top=contentTop-26,bottom=contentBottom+12,height=bottom-top;
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 830 ${height*2+12}" aria-hidden="true">`;
  for(let system=0;system<2;system++){
    svg+=`<g transform="translate(0 ${system*height-top})">`;
    for(let y=72;y<=128;y+=14)svg+=`<line class="staff-line" x1="24" y1="${y}" x2="806" y2="${y}"/>`;
    svg+='<text x="31" y="132" font-size="80" fill="#364335" font-family="Segoe UI Symbol,serif">𝄞</text><text x="50" y="157" font-size="12" fill="#63705e">8</text>';
    if(system===0)svg+='<text x="86" y="96" font-family="Georgia" font-size="26" fill="#364335">4</text><text x="86" y="122" font-family="Georgia" font-size="26" fill="#364335">4</text>';
    for(let bar=0;bar<2;bar++){
      const globalBar=system*2+bar,start=118+bar*344;
      svg+=`<text x="${start}" y="${top+15}" font-size="10" fill="#9b9e91" font-family="Segoe UI">${globalBar+1}</text>`;
      svg+=`<line x1="${start+344}" y1="72" x2="${start+344}" y2="128" stroke="#a5ad9d"/>`;
      const accState=new Map();
      score.forEach((event,index)=>{
        if(Math.floor(event.beat/4)!==globalBar)return;
        const x=start+50+(event.beat%4)*(285/4),y=ys[index],n=spell(event.midi+12,settings),accKey=n.letter+n.oct;
        const change=(accState.get(accKey)||0)!==n.acc;accState.set(accKey,n.acc);
        svg+=`<g class="sheet-note ${index===active?'current':''}" data-note-index="${index}"><rect class="focus-box" x="${x-30}" y="${contentTop-8}" width="61" height="${contentBottom-contentTop+16}" rx="12"/>`;
        for(let ledger=142;ledger<=y+1;ledger+=14)svg+=`<line class="note-ink ledger" x1="${x-16}" y1="${ledger}" x2="${x+16}" y2="${ledger}"/>`;
        for(let ledger=58;ledger>=y-1;ledger-=14)svg+=`<line class="note-ink ledger" x1="${x-16}" y1="${ledger}" x2="${x+16}" y2="${ledger}"/>`;
        if(change)svg+=`<text class="note-ink" x="${x-29}" y="${y+8}" font-size="24" stroke-width="0" font-family="Segoe UI Symbol,serif">${n.acc===0?'♮':n.acc>0?'♯'.repeat(n.acc):'♭'.repeat(-n.acc)}</text>`;
        svg+=`<ellipse class="note-ink note-head ${event.duration>1?'open':''}" cx="${x}" cy="${y}" rx="${event.duration===4?12:10}" ry="6.7" transform="rotate(${event.duration===4?0:-18} ${x} ${y})" stroke-width="2.2"/>`;
        if(event.duration<4){const up=y>=100;svg+=`<line class="note-ink" x1="${x+(up?9:-9)}" y1="${y}" x2="${x+(up?9:-9)}" y2="${y+(up?-38:38)}" stroke-width="1.7"/>`;}
        svg+=`<text class="note-hint" x="${x}" y="${hintYs[index]}" text-anchor="middle">${settings.hints?noteName(event.midi,settings):''}</text>`;
        if(needsStringNumber(event.midi))svg+=`<g class="string-indication" aria-label="Required string ${event.position.string}"><circle cx="${x}" cy="${marks[index]}" r="9" fill="#fffef9" stroke="#67745f" stroke-width="1"/><text x="${x}" y="${marks[index]+4}" text-anchor="middle" font-size="12" font-weight="600" fill="#45533e">${event.position.string}</text></g>`;
        svg+='</g>';
      });
    }svg+=`<line class="score-playhead" data-system="${system}" x1="0" x2="0" y1="${top+20}" y2="${bottom}" stroke="#c95d3e" stroke-width="1.4" opacity="0"/></g>`;
  }
  $('sheet').innerHTML=svg+'</svg>';
  $('sheet').setAttribute('aria-label',`Four bars of 4/4 guitar music, ${settings.duration} beats per note. ${settings.hints?score.map(n=>noteName(n.midi,settings)).join(', '):'Note names hidden for sight reading.'} Circled numbers indicate strings when a pitch has multiple locations on the guitar.`);
  updateScoreMarks();
}
function updateScoreMarks(){
  $('sheet').querySelectorAll('[data-note-index]').forEach(el=>{const i=Number(el.dataset.noteIndex);el.classList.toggle('current',i===active&&!finished);el.classList.toggle('success',results[i]?.correct===true);el.classList.toggle('miss',results[i]?.correct===false);});
}
function updatePlayhead(){
  const beat=settings.mode==='wait'?currentEvent()?.beat:position;
  $('sheet').querySelectorAll('.score-playhead').forEach(el=>{
    const system=Number(el.dataset.system),visible=running&&position>=0&&Math.floor(beat/8)===system;
    el.setAttribute('opacity',visible?'.55':'0');
    if(visible){const x=168+Math.floor((beat%8)/4)*344+(beat%4)*285/4;el.setAttribute('x1',x);el.setAttribute('x2',x);}
  });
}
function renderFretboard(){
  const event=currentEvent(),cols=settings.maxFret+1,width=Math.max(710,cols*50+70),step=(width-80)/cols,x=f=>65+f*step;
  $('fretboard').style.minWidth=`${Math.max(630,cols*37+70)}px`;
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 225" aria-label="Guitar fretboard; high E string at top">`;
  for(let f=0;f<=settings.maxFret;f++){
    svg+=`<text x="${x(f)}" y="18" text-anchor="middle" font-size="10" fill="#c3c6ab">${f===0?'OPEN':f}</text>`;
    if(f)svg+=`<line x1="${x(f)-step/2}" y1="35" x2="${x(f)-step/2}" y2="195" stroke="${f===1?'#d5c8a1':'#686c55'}" stroke-width="${f===1?5:1.5}"/>`;
    if([3,5,7,9,12,15,17,19,21,24].includes(f))for(const y of f%12===0?[100,130]:[115])svg+=`<circle cx="${x(f)}" cy="${y}" r="4" fill="#666c50"/>`;
  }
  const allowed=positions(settings);
  TUNING.forEach((base,i)=>{
    const y=44+i*28;svg+=`<text x="20" y="${y+4}" font-size="12" fill="#e1dccc" text-anchor="middle">${ROOTS[mod(base)]}<tspan font-size="8" dx="3">${i+1}</tspan></text><line x1="43" y1="${y}" x2="${width-15}" y2="${y}" stroke="#a6a38c" stroke-width="${.8+i*.23}"/>`;
    for(let f=0;f<=settings.maxFret;f++){
      const midi=base+f,enabled=allowed.some(p=>p.string===i+1&&p.fret===f),match=event&&midi===event.midi&&(settings.hints||revealed),assigned=match&&i+1===event.position.string&&f===event.position.fret;
      const label=match?noteName(midi,settings):'';
      svg+=`<g class="fret-cell" role="button" tabindex="${enabled?0:-1}" aria-label="String ${i+1}, fret ${f}${settings.hints?', '+noteName(midi,settings):''}" data-string="${i+1}" data-fret="${f}"><rect class="fret-hit" x="${x(f)-step/2+1}" y="${y-13}" width="${step-2}" height="26" rx="5" fill="transparent"/>`;
      if(match)svg+=`<circle cx="${x(f)}" cy="${y}" r="13" fill="${assigned?'#edb782':'#4f6549'}" stroke="${assigned?'#ffe3bf':'#a9bd95'}" stroke-width="${assigned?2:1}"/><text x="${x(f)}" y="${y+3.5}" font-size="9" font-weight="700" text-anchor="middle" fill="${assigned?'#302f25':'#e6edd7'}">${label}</text>`;
      else if(enabled)svg+=`<circle cx="${x(f)}" cy="${y}" r="3" fill="#91977a"/>`;
      svg+='</g>';
    }
  });$('fretboard').innerHTML=svg+'</svg>';
  $('position-legend').textContent=event&&(settings.hints||revealed)?`Exact ${noteName(event.midi,settings)} · gold = assigned position`:'Dots = selected notes · reveal when you need a hint';
  $('reveal').textContent=revealed?'Hide positions':'Reveal positions';
  if(event&&(settings.hints||revealed)){
    const scroller=$('fretboard').parentElement,renderWidth=$('fretboard').getBoundingClientRect().width,location=x(event.position.fret)*renderWidth/width;
    if(location<scroller.scrollLeft+30||location>scroller.scrollLeft+scroller.clientWidth-30)scroller.scrollLeft=Math.max(0,location-scroller.clientWidth/2);
  }
}
function showCurrent(){
  const event=currentEvent();
  if(!event){$('current-pitch').textContent='—';return;}
  const n=spell(event.midi,settings),name=n.name.replace(/-?\d+$/,'');
  $('current-pitch').innerHTML=settings.hints||revealed?`${name}<span>${n.oct}</span>`:'<span>Read ♩</span>';
  $('cue-label').textContent=position<0?'NEXT · SOUNDING PITCH':'NOW · SOUNDING PITCH';
  if(position>=0)setCue(`Play on string ${event.position.string}`,settings.hints||revealed?`${noteName(event.midi,settings)} · fret ${event.position.fret} · ${frequency(event.midi).toFixed(1)} Hz`:'Read the staff. Find this pitch on the assigned string.');
  updateScoreMarks();renderFretboard();
  const note=$('sheet').querySelector('.sheet-note.current'),scroll=$('sheet').parentElement;
  if(note){const a=note.getBoundingClientRect(),b=scroll.getBoundingClientRect();if(a.right>b.right-15||a.left<b.left+15)scroll.scrollLeft+=a.left-b.left-scroll.clientWidth/3;}
}
function lockSetup(locked){$('score-settings').disabled=locked;for(const id of ['bpm','bpm-up','bpm-down','target-bpm','new-phrase','hints','add-note'])$(id).disabled=locked;updateRecommendation();}
function beatNow(){return running?phaseOffset+(performance.now()-phaseTime)/1000/secondsPerBeat():position;}
async function start(){
  if(starting||running||!score.length)return;stopPreview();const generation=++startGeneration;starting=true;$('play').innerHTML='× <span>Cancel start</span>';updateSoundControls();
  try{await audio.init();audio.setVolume(settings.volume);}catch{notice('Audio is unavailable; the visual playhead still works.');}
  if(generation!==startGeneration)return;
  await prepareMetronome();
  if(generation!==startGeneration)return;
  if(settings.drums!=='off'&&!await prepareDrums()){if(generation===startGeneration)pause();return;}
  if(generation!==startGeneration||document.hidden){if(generation===startGeneration)pause();return;}
  if(finished)newScore();sessionSaved=false;running=true;starting=false;runStarted=performance.now();phaseTime=runStarted;phaseOffset=position;nextBeat=Math.ceil(position);
  $('play').innerHTML='Ⅱ <span>Pause</span>';lockSetup(true);updateSoundControls();
  if(settings.backing==='upload'&&audible()&&position>=0)playUserTrack();
  scheduler=setInterval(scheduleAudio,25);scheduleAudio();raf=requestAnimationFrame(tick);
  if(settings.mode==='wait'&&results[active])queueWaitAdvance();
}
function scheduleAudio(){
  if(!running||!audio.context)return;const now=beatNow();
  while(nextBeat<=now+.12/secondsPerBeat()){
    if(nextBeat>=now-.1&&(settings.mode==='wait'||settings.loop||nextBeat<16))audio.beat(audio.context.currentTime+Math.max(0,(nextBeat-now)*secondsPerBeat()),nextBeat,settings);
    nextBeat++;
  }
}
function pause(){
  startGeneration++;starting=false;stopPreview();
  if(!running){$('play').innerHTML='▶ <span>Play score</span>';updateSoundControls();return;}
  position=beatNow();practiceMs+=performance.now()-runStarted;running=false;clearInterval(scheduler);cancelAnimationFrame(raf);clearTimeout(waitAdvance);audio.stopVoices();$('user-track').pause();$('play').innerHTML='▶ <span>Resume</span>';lockSetup(false);updateSoundControls();updateStats();updatePlayhead();
}
function tick(){
  if(!running)return;position=beatNow();
  const beat=Math.floor(position);document.querySelectorAll('.beat-dots i').forEach((el,i)=>el.classList.toggle('active',mod(beat,4)===i));
  if(position<0){$('cue-label').textContent='COUNT IN';$('current-pitch').textContent=Math.ceil(-position);setCue('One, two, three, four…',!audible()?'Watch the pulse. Enable headphones for an audible count-in.':'Get ready. The first note starts after four beats.');}
  else{
    if(settings.mode==='timed'&&position>=16){completePhrase();return;}
    const next=settings.mode==='timed'?Math.min(score.length-1,Math.floor(position/settings.duration)):active;
    if(next!==active||$('cue-label').textContent==='COUNT IN'){
      for(let i=active;i<next;i++)if(!results[i])markMiss(i);
      active=next;revealed=false;showCurrent();
      if(settings.backing==='upload'&&audible()&&$('user-track').paused)playUserTrack();
    }
  }
  updateStats();updatePlayhead();if(settings.goal&&elapsed()>=settings.goal*60000){finishSession();return;}
  raf=requestAnimationFrame(tick);
}
function addAttempt(midi,correct){const n=progress.notes[midi]||{correct:0,attempts:0,passes:[],last:0};n.correct+=correct?1:0;n.attempts++;n.last=Date.now();progress.notes[midi]=n;}
function markMiss(index){results[index]={correct:false};stats.missed++;stats.streak=0;addAttempt(score[index].midi,false);}
function answer(midi,{manual=false,string=null,at=performance.now()}={}){
  if(!running||position<0||finished){notice('Press Play and wait for the count-in.');return;}
  const event=currentEvent();if(!event||results[active])return;
  if(midi!==event.midi||(string!==null&&string!==event.position.string)){
    stats.wrong++;stats.streak=0;addAttempt(event.midi,false);event.hadError=true;
    setCue(midi===event.midi?`Right pitch. Try string ${event.position.string}.`:mod(midi)===mod(event.midi)?`That’s ${noteName(midi,settings)} — ${midi>event.midi?'too high':'too low'} by an octave or more.`:`Heard ${noteName(midi,settings)}. Try again.`,settings.hints?`Target: ${noteName(event.midi,settings)} on string ${event.position.string}`:'Follow the highlighted note on the staff.');updateStats();return;
  }
  const offset=settings.mode==='timed'?(phaseOffset+(at-phaseTime)/1000/secondsPerBeat()-event.beat)*secondsPerBeat():null;
  const timing=offset===null?'At your pace':timingGrade(offset,secondsPerBeat());
  results[active]={correct:true,timing,manual,offset,assisted:settings.hints||revealed};stats.correct++;stats.streak++;stats.best=Math.max(stats.best,stats.streak);if(timing==='On time')stats.onTime++;if(manual)stats.manual++;
  addAttempt(event.midi,true);
  // Rotate assigned locations in all modes; this counts assignments, not verified fingering.
  const key=event.position.string+':'+event.position.fret;progress.positionUse[key]=(progress.positionUse[key]||0)+1;
  setCue(manual?'Marked as played ✓':`${noteName(event.midi,settings)} · ${timing.toLowerCase()} ✓`,micOn?'Pitch and octave checked. Use the assigned string.':`String ${event.position.string} · ${manual?'self-check':'fretboard check'}`);
  updateScoreMarks();updateStats();
  if(settings.mode==='wait')queueWaitAdvance();
}
function queueWaitAdvance(){clearTimeout(waitAdvance);waitAdvance=setTimeout(()=>{if(!running)return;if(active>=score.length-1)completePhrase();else{active++;revealed=false;showCurrent();}},350);}
function completePhrase(){
  cancelAnimationFrame(raf);clearTimeout(waitAdvance);
  for(let i=0;i<score.length;i++)if(!results[i])markMiss(i);
  const clean=score.every((n,i)=>results[i].correct&&!results[i].assisted&&!n.hadError&&(results[i].manual||results[i].timing==='On time'))&&settings.mode==='timed'&&settings.bpm>=settings.targetBpm;
  cleanPasses=clean?cleanPasses+1:0;
  if(clean){for(const midi of new Set(score.map(n=>n.midi))){const n=progress.notes[midi];n.passes.push({bpm:settings.bpm,duration:settings.duration,hints:false,hits:score.filter(e=>e.midi===midi).length,at:Date.now(),source:micOn?'microphone':'self-check'});n.passes=n.passes.slice(-30);}notice('Clean pass at your target tempo. Nice work.');}
  persist();const rec=recommendation(settings,progress);
  if(rec.ready&&settings.autoAdd&&rec.next!==null){settings.pool.push(rec.next);notice(`${pitchClassName(rec.next)} added in every selected octave. Slow down anytime.`);cleanPasses=0;syncControls();persist();}
  if(!settings.loop){pause();finished=true;position=16;active=score.length-1;updateScoreMarks();$('play').innerHTML='▶ <span>Play again</span>';setCue('Phrase complete.',rec.ready?'Ready to add the recommended next note.':'Try it again, or adjust the tempo.');updateRecommendation();return;}
  // Continue on the same beat grid, without a new count-in or drift between phrases.
  const overflow=settings.mode==='timed'?Math.max(0,position-16):0;
  if(settings.mode==='wait')audio.stopVoices();
  score=makeScore(settings,Math.random,progress.positionUse);results=score.map(()=>null);active=0;revealed=false;phaseTime=performance.now();phaseOffset=overflow;position=overflow;nextBeat=settings.mode==='timed'?Math.max(0,nextBeat-16):0;
  renderScore();showCurrent();updateRecommendation();scheduleAudio();raf=requestAnimationFrame(tick);
}
function updateStats(){
  const ms=elapsed(),attempts=stats.correct+stats.wrong+stats.missed;
  $('clock').textContent=clockText(ms);$('correct').textContent=stats.correct;$('streak').innerHTML=`${stats.streak} <small>✦</small>`;
  $('accuracy').textContent=attempts?`${Math.round(stats.correct/attempts*100)}%`:'—';$('accuracy-label').textContent=stats.manual?'Self-rated / checked':'Pitch accuracy';
  $('timing-stat').textContent=`${stats.onTime} on-time ${micOn?'detected':'checked'} notes`;
  $('goal-progress').style.width=settings.goal?`${Math.min(100,ms/(settings.goal*60000)*100)}%`:'0%';
  $('goal-label').textContent=settings.goal?`A ${settings.goal}-minute moment for your music`:'Open practice · take your time';
}
function renderHistory(){
  $('total-minutes').textContent=Math.round(progress.sessions.reduce((n,s)=>n+(Number(s.ms)||0),0)/60000);
  $('best-streak').textContent=Math.max(0,...progress.sessions.map(s=>Number(s.best)||0));
  $('history-copy').textContent=progress.sessions.length?`${progress.sessions.length} saved session${progress.sessions.length===1?'':'s'}. Keep the old notes close as you learn new ones.`:'Your first session is the start of something good.';
}
function finishSession(){
  pause();disableMic();const ms=practiceMs;if(!ms){notice('Start a little practice first.');return;}
  if(!sessionSaved){progress.sessions.push({at:Date.now(),ms,...stats,bpm:settings.bpm,pool:settings.pool,octaves:settings.octaves});progress.sessions=progress.sessions.slice(-365);sessionSaved=true;persist();}
  $('summary-copy').textContent=`${clockText(ms)} of practice across ${settings.minFret}–${settings.maxFret} frets. ${stats.manual?'Manual results include your self-checks.':'Pitch results reflect microphone or fretboard checks.'}`;
  $('summary-stats').innerHTML=`<div><strong>${stats.correct}</strong><span>notes played</span></div><div><strong>${stats.best}</strong><span>best streak</span></div><div><strong>${stats.onTime}</strong><span>on-time notes</span></div><div><strong>${stats.missed}</strong><span>unplayed / unmarked</span></div>`;
  $('summary-dialog').showModal();renderHistory();practiceMs=0;stats={correct:0,wrong:0,missed:0,streak:0,best:0,onTime:0,manual:0};newScore();updateStats();
}
function routeAudio(){
  audio.muted=!audible();audio.setVolume(settings.volume);
  if(!audible()){audio.stopVoices();$('user-track').pause();}else if(running&&position>=0)playUserTrack();
  if(micOn)$('mic-status').textContent=settings.headphones?'Headphones mode: drums, metronome and backing are on. Play one string at a time. Your microphone audio stays on this device.':'Exact pitch + octave + timing. App audio is muted to avoid false matches. Use headphones below to hear drums, the metronome and backing.';
  updateSoundControls();
}
function disableMic(){audio.stopMic();audio.setVolume(settings.volume);micOn=false;micPending=false;micLatched=false;micPitch=null;lastRms=0;$('mic').classList.remove('active');$('mic').innerHTML='<span>◉</span> Enable microphone';$('mic').disabled=false;$('pitch-meter').hidden=true;$('headphones-wrap').hidden=true;$('hear').disabled=false;$('got-it').disabled=false;$('mic-status').textContent='Manual mode. Tap the fretboard, or self-check with “I played it.”';updateSoundControls();}
async function toggleMic(){
  if(micOn||micPending){disableMic();return;}pause();micPending=true;$('mic').disabled=true;$('mic').textContent='Waiting for microphone permission…';
  try{const started=await audio.startMic(onPitch);if(!started)return;micOn=true;micPending=false;$('mic').disabled=false;$('mic').classList.add('active');$('mic').innerHTML='<span>◉</span> Microphone on · turn off';$('pitch-meter').hidden=false;$('headphones-wrap').hidden=false;$('hear').disabled=true;$('got-it').disabled=true;routeAudio();notice('Microphone ready. Pluck a single note, then press Play.');}
  catch(error){disableMic();$('mic-status').textContent=error.name==='NotAllowedError'?'Microphone permission was declined. Manual practice still works.':error.name==='NotFoundError'?'No microphone was found. Manual practice still works.':error.message;}
}
function onPitch(detection){
  if(detection?.ended){disableMic();notice('Microphone disconnected. Manual mode is available.');return;}
  const now=performance.now();
  if(!detection){micPitch=null;micLatched=false;lastRms=0;$('heard-pitch').textContent='—';$('heard-detail').textContent='Pluck one string clearly. Damp it before repeating.';return;}
  const match=pitchMatch(currentEvent()?.midi??60,detection.frequency),heard=match.heard;
  const attack=detection.rms>Math.max(.014,lastRms*1.8)&&now-lastAttack>260;
  if(heard!==micPitch||attack){micPitch=heard;micSince=now;micOnset=now;micLatched=false;if(attack)lastAttack=now;}
  lastRms=lastRms?lastRms*.55+detection.rms*.45:detection.rms;
  $('heard-pitch').textContent=noteName(heard,settings);
  const tuning=100*(69+12*Math.log2(detection.frequency/440)-heard);
  $('heard-detail').textContent=`${detection.frequency.toFixed(1)} Hz · ${Math.round(tuning)>0?'+':''}${Math.round(tuning)} cents${match.octaveError?' · wrong octave':''}`;
  if(!running||position<0||micLatched||now-micSince<150)return;
  if(heard===currentEvent()?.midi&&!match.correct){$('heard-detail').textContent+=' · tune closer to the target';return;}
  micLatched=true;answer(heard,{at:micOnset});
}
function changeSetup(){pause();settings=sanitizeSettings(settings);cleanPasses=0;syncControls();newScore();persist();updateStats();}
function toggleArray(key,value){const a=settings[key];if(a.includes(value)){if(a.length===1){notice('Keep at least one selected.');return;}settings[key]=a.filter(v=>v!==value);}else settings[key]=[...a,value];changeSetup();}
function playUserTrack(){if(trackURL&&settings.backing==='upload'&&audible())$('user-track').play().catch(()=>notice('Tap Play again to allow your audio file to start.'));}
$('play').onclick=()=>running||starting?pause():start();
$('restart').onclick=()=>{pause();newScore();$('user-track').currentTime=0;$('play').innerHTML='▶ <span>Play score</span>';};
$('new-phrase').onclick=()=>{pause();newScore();};
$('finish').onclick=finishSession;
$('start-note').onchange=()=>{settings.pool=[Number($('start-note').value)];changeSetup();};
for(const id of ['root','scale'])$(id).onchange=()=>{settings[id]=id==='root'?Number($(id).value):$(id).value;settings.pool=[settings.root];changeSetup();};
$('note-palette').onclick=e=>{const b=e.target.closest('[data-pc]');if(b)toggleArray('pool',Number(b.dataset.pc));};
$('octaves').onclick=e=>{const b=e.target.closest('[data-octave]');if(b)toggleArray('octaves',Number(b.dataset.octave));};
$('strings').onclick=e=>{const b=e.target.closest('[data-string]');if(b)toggleArray('strings',Number(b.dataset.string));};
for(const [id,key] of [['duration','duration'],['bpm','bpm'],['target-bpm','targetBpm'],['min-fret','minFret'],['max-fret','maxFret']])$(id).onchange=()=>{settings[key]=Number($(id).value);changeSetup();};
$('mode').onchange=()=>{settings.mode=$('mode').value;changeSetup();};
for(const [id,amount] of [['bpm-up',5],['bpm-down',-5]])$(id).onclick=()=>{settings.bpm+=amount;changeSetup();};
$('hints').onchange=()=>{settings.hints=$('hints').checked;changeSetup();};
$('auto-add').onchange=()=>{settings.autoAdd=$('auto-add').checked;persist();};
$('loop').onchange=()=>{settings.loop=$('loop').checked;persist();};
$('metronome').onchange=()=>{settings.metronome=$('metronome').checked;if(!settings.metronome&&position>=0)audio.metronome?.stop();persist();};
$('metronome-sound').onchange=()=>{pause();settings.metronomeSound=$('metronome-sound').value;updateSoundControls();persist();};
$('metronome-volume').oninput=()=>{settings.metronomeVolume=Number($('metronome-volume').value);audio.metronome?.setVolume(settings.metronomeVolume);updateSoundControls();persist();};
$('metronome-accent').onchange=()=>{settings.metronomeAccent=$('metronome-accent').checked;persist();};
$('metronome-preview').onclick=previewMetronome;
$('guitar-sound').onchange=()=>changeGuitarSound('guitarSound',$('guitar-sound').value);
$('guitar-touch').onchange=()=>changeGuitarSound('guitarTouch',Number($('guitar-touch').value));
$('guitar-volume').oninput=()=>{settings.guitarVolume=Number($('guitar-volume').value);audio.guitar?.setVolume(settings.guitarVolume);$('guitar-volume-value').textContent=`${settings.guitarVolume}%`;persist();};
$('headphones').onchange=()=>{settings.headphones=$('headphones').checked;routeAudio();persist();};
$('goal').onchange=()=>{settings.goal=Number($('goal').value);updateStats();persist();};
$('volume').oninput=()=>{settings.volume=Number($('volume').value);audio.setVolume(settings.volume);$('user-track').volume=settings.volume/100;persist();};
$('backing').onchange=()=>{settings.backing=$('backing').value;audio.stopVoices();$('user-track').pause();syncControls();if(running&&position>=0)playUserTrack();persist();};
$('drums').onchange=()=>{pause();settings.drums=$('drums').value;updateSoundControls();persist();};
$('drum-volume').oninput=()=>{settings.drumVolume=Number($('drum-volume').value);audio.drums?.setVolume(settings.drumVolume);updateSoundControls();persist();};
$('drum-fills').onchange=()=>{settings.drumFills=$('drum-fills').checked;persist();};
$('drum-preview').onclick=previewDrums;
$('drum-retry').onclick=prepareDrums;
$('audio-file').onchange=()=>{const file=$('audio-file').files?.[0];if(!file)return;$('user-track').pause();if(trackURL)URL.revokeObjectURL(trackURL);trackURL=URL.createObjectURL(file);$('user-track').src=trackURL;$('audio-name').textContent=file.name;if(running&&position>=0)playUserTrack();};
$('user-track').onerror=()=>notice('This audio file could not be played. Try MP3, WAV, or another supported format.');
$('mic').onclick=toggleMic;
$('reveal').onclick=()=>{revealed=!revealed;if(running&&position>=0&&currentEvent())currentEvent().hadError=true;showCurrent();};
$('hear').onclick=async()=>{const event=currentEvent();if(!event||!audible())return;if(running)event.hadError=true;try{await hearGuitar(event.position,()=>currentEvent()===event);}catch(e){notice(e.message);}};
$('got-it').onclick=()=>{if(currentEvent())answer(currentEvent().midi,{manual:true});};
$('skip').onclick=()=>{if(!running||position<0)return;if(!results[active])markMiss(active);if(settings.mode==='wait'){if(active===score.length-1)completePhrase();else{active++;revealed=false;showCurrent();}}else{updateScoreMarks();setCue('Note skipped.','Join back in on the next highlighted note.');}updateStats();};
function fretAnswer(el){if(!el||!currentEvent())return;const string=Number(el.dataset.string),fret=Number(el.dataset.fret);if(!settings.strings.includes(string)||fret<settings.minFret)return;answer(TUNING[string-1]+fret,{string});}
$('fretboard').onclick=e=>fretAnswer(e.target.closest('[data-string][data-fret]'));
$('fretboard').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){const el=e.target.closest('[data-string][data-fret]');if(el){e.preventDefault();e.stopPropagation();fretAnswer(el);}}};
$('add-note').onclick=()=>{const rec=recommendation(settings,progress);if(rec.next!==null){settings.pool.push(rec.next);changeSetup();notice(`${pitchClassName(rec.next)} added in every selected octave. Lower the tempo while it feels new.`);}};
const noteMap=createNoteMap({
  getSettings:()=>settings,
  beforeOpen:()=>{pause();if(position>=0&&position<16&&!finished)score.forEach(note=>{note.hadError=true;});},
  canHear:audible,
  hear:hearGuitar,
  onSoundChange:changeGuitarSound,
  stopSound:()=>audio.stopVoices()
});
$('map-open').onclick=()=>noteMap.open(settings.pool[0]);
$('map-current').onclick=()=>noteMap.open(currentEvent()?mod(currentEvent().midi):settings.pool[0]);
$('map-next').onclick=()=>{const next=recommendation(settings,progress).next;if(next!==null)noteMap.open(next);};
$('help-open').onclick=()=>{pause();$('help-dialog').showModal();};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('reset-progress').onclick=()=>{pause();if(!confirm('Reset saved practice history and note progress on this device? Your practice settings will stay.'))return;progress={sessions:[],notes:{},positionUse:{}};cleanPasses=0;persist();renderHistory();updateRecommendation();notice('Saved practice progress reset.');};
document.addEventListener('keydown',e=>{if(e.repeat||document.querySelector('dialog[open]')||e.target.closest('input,select,textarea,button,[role="button"]'))return;if(e.code==='Space'){e.preventDefault();running?pause():start();}if(e.key==='Enter'&&!micOn){e.preventDefault();if(currentEvent())answer(currentEvent().midi,{manual:true});}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){pause();disableMic();persist();}});
window.addEventListener('pagehide',()=>{pause();audio.stopMic();if(trackURL)URL.revokeObjectURL(trackURL);persist();});
setupControls();newScore();updateStats();renderHistory();
