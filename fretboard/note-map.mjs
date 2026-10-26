import {TUNING,DEFAULTS,mod,spell,noteName,accidental,frequency} from './music.mjs?v=5';
import {GUITAR_TOUCHES,guitarVoiceLabel} from './guitar.mjs?v=1';

export const MAP_FRETS=21;
const COLORS=['#e6c478','#dc9b80','#a3c4ab','#95bcd5','#c1ace0'];
const pitchClassName=(pc,settings)=>spell(60+pc,settings).name.replace(/-?\d+$/,'');

// Study the whole instrument, independently of the current exercise filters.
export function noteMapGroups(pc,settings=DEFAULTS){
  const groups=new Map();
  TUNING.forEach((base,index)=>{
    for(let fret=0;fret<=MAP_FRETS;fret++){
      const midi=base+fret;if(mod(midi)!==mod(pc))continue;
      if(!groups.has(midi)){
        const sounding=spell(midi,settings);
        groups.set(midi,{midi,name:sounding.name,octave:sounding.oct,writtenName:noteName(midi+12,settings),color:COLORS[mod(sounding.oct-2,COLORS.length)],positions:[]});
      }
      groups.get(midi).positions.push({string:index+1,fret,midi});
    }
  });
  return [...groups.values()].sort((a,b)=>a.midi-b.midi);
}

export function staffGeometry(midi,settings=DEFAULTS){
  const written=spell(midi+12,settings),y=128-(written.step-30)*7,ledgers=[];
  for(let line=142;line<=y+1;line+=14)ledgers.push(line);
  for(let line=58;line>=y-1;line-=14)ledgers.push(line);
  return {written,y,ledgers};
}

function staffSVG(group,settings,top,bottom){
  const {written,y,ledgers}=staffGeometry(group.midi,settings),x=135,up=y>=100;
  return `<svg class="map-staff" viewBox="0 ${top} 230 ${bottom-top}" role="img" aria-label="${group.name} sounding, written ${group.writtenName} in guitar treble notation">
    ${[72,86,100,114,128].map(line=>`<line x1="14" y1="${line}" x2="216" y2="${line}" stroke="#9da899"/>`).join('')}
    <text x="20" y="132" font-size="80" fill="#28382f" font-family="Segoe UI Symbol,serif">𝄞</text><text x="39" y="157" font-size="12" fill="#63705e">8</text>
    ${ledgers.map(line=>`<line x1="${x-17}" y1="${line}" x2="${x+17}" y2="${line}" stroke="#28382f" stroke-width="1.3"/>`).join('')}
    ${written.acc?`<text x="${x-32}" y="${y+8}" font-size="25" fill="#28382f" font-family="Segoe UI Symbol,serif">${accidental(written.acc)}</text>`:''}
    <ellipse cx="${x}" cy="${y}" rx="10" ry="6.7" transform="rotate(-18 ${x} ${y})" fill="#28382f"/>
    <line x1="${x+(up?9:-9)}" y1="${y}" x2="${x+(up?9:-9)}" y2="${y+(up?-38:38)}" stroke="#28382f" stroke-width="1.7"/>
    <g class="map-string-mark" visibility="hidden"><circle cx="${x}" cy="${bottom-15}" r="10" fill="#fffef9" stroke="#63705e"/><text x="${x}" y="${bottom-11}" text-anchor="middle" font-size="12" fill="#28382f"></text></g>
  </svg>`;
}

function neckSVG(groups){
  const x=fret=>85+fret*46;
  let svg='<svg viewBox="0 0 1100 270" role="group" aria-label="Full 21-fret guitar note map. String 1, high E, is at the top.">';
  for(let fret=0;fret<=MAP_FRETS;fret++){
    svg+=`<text x="${x(fret)}" y="26" text-anchor="middle" font-size="11" fill="#e1dccc">${fret===0?'OPEN':fret}</text>`;
    if(fret)svg+=`<line x1="${x(fret)-23}" y1="45" x2="${x(fret)-23}" y2="249" stroke="${fret===1?'#d5c8a1':'#686c55'}" stroke-width="${fret===1?5:1.5}"/>`;
    if([3,5,7,9,12,15,17,19,21].includes(fret))for(const y of fret===12?[113,181]:[147])svg+=`<circle cx="${x(fret)}" cy="${y}" r="4" fill="#666c50"/>`;
  }
  TUNING.forEach((midi,i)=>{
    const y=62+i*34;
    svg+=`<text x="33" y="${y+4}" text-anchor="middle" font-size="12" fill="#e1dccc">${i+1} · ${noteName(midi)}</text><line x1="65" y1="${y}" x2="1080" y2="${y}" stroke="#a6a38c" stroke-width="${.8+i*.23}"/>`;
  });
  for(const group of groups)for(const p of group.positions){
    const y=62+(p.string-1)*34;
    svg+=`<g class="map-position" role="button" tabindex="0" aria-pressed="false" aria-label="${group.name}, string ${p.string}, ${p.fret===0?'open string':'fret '+p.fret}" data-map-string="${p.string}" data-map-fret="${p.fret}" data-map-midi="${p.midi}">
      <rect class="map-hit" x="${x(p.fret)-22}" y="${y-17}" width="44" height="34" rx="8" fill="transparent"/>
      <circle cx="${x(p.fret)}" cy="${y}" r="15" fill="${group.color}" stroke="#ffffff60"/>
      <text x="${x(p.fret)}" y="${y+3.5}" font-size="10" font-weight="700" text-anchor="middle" fill="#20332d">${group.name}</text></g>`;
  }
  return svg+'</svg>';
}

export function createNoteMap({getSettings,beforeOpen,canHear,hear,stopSound,onSoundChange}){
  const $=id=>document.getElementById(id),dialog=$('note-map-dialog');
  let settings=DEFAULTS,pc=0,groups=[],octave='all',selected=null,generation=0;
  const visibleGroups=()=>octave==='all'?groups:groups.filter(g=>g.midi===Number(octave));
  function cancelSound(){generation++;stopSound();$('map-hear').removeAttribute('aria-busy');}
  function syncSoundControls(){
    const s=getSettings();$('map-guitar-sound').value=s.guitarSound;
    $('map-guitar-touch').innerHTML=GUITAR_TOUCHES[s.guitarSound].map((label,i)=>`<option value="${i+1}">${label}</option>`).join('');$('map-guitar-touch').value=s.guitarTouch;
  }
  function renderOctaves(){
    $('map-octaves').innerHTML=[{value:'all',label:'All octaves'},...groups.map(g=>({value:g.midi,label:g.name}))].map(o=>`<button type="button" data-map-octave="${o.value}" aria-pressed="${String(o.value)===octave}">${o.label}</button>`).join('');
  }
  function render(){
    const visible=visibleGroups(),ys=groups.map(g=>staffGeometry(g.midi,settings).y);
    const top=Math.min(26,...ys.map(y=>y-44)),bottom=Math.max(190,...ys.map(y=>y+66));
    $('map-title').textContent=`Meet ${pitchClassName(pc,settings)}, everywhere.`;
    $('map-count').textContent=`${visible.reduce((sum,g)=>sum+g.positions.length,0)} locations · ${visible.length} sounding ${visible.length===1?'octave':'octaves'} · frets 0–21`;
    $('map-neck').innerHTML=neckSVG(visible);
    $('map-staves').innerHTML=visible.map(g=>`<article class="map-octave-card" data-map-card="${g.midi}" style="--octave-color:${g.color}">
      <div class="map-card-heading"><h3><i></i>${g.name}</h3><span>${g.positions.length} ${g.positions.length===1?'location':'locations'}</span></div>
      <p>Sounds <strong>${g.name}</strong> · written ${g.writtenName}</p>
      ${staffSVG(g,settings,top,bottom)}
      <div class="map-locations" aria-label="${g.name} locations">${g.positions.map(p=>`<button type="button" class="map-location" data-map-string="${p.string}" data-map-fret="${p.fret}" data-map-midi="${p.midi}" aria-pressed="false" aria-label="${g.name}, string ${p.string}, ${p.fret===0?'open string':'fret '+p.fret}"><span class="map-string-circle">${p.string}</span> ${p.fret===0?'open':'fret '+p.fret}</button>`).join('')}</div>
    </article>`).join('');
    updateSelection();
  }
  function updateSelection(){
    dialog.querySelectorAll('[data-map-string][data-map-fret]').forEach(el=>el.setAttribute('aria-pressed',String(!!selected&&Number(el.dataset.mapString)===selected.string&&Number(el.dataset.mapFret)===selected.fret)));
    dialog.querySelectorAll('[data-map-card]').forEach(card=>{
      const active=!!selected&&Number(card.dataset.mapCard)===selected.midi;card.classList.toggle('selected',active);
      const mark=card.querySelector('.map-string-mark');mark.setAttribute('visibility',active?'visible':'hidden');mark.querySelector('text').textContent=active?selected.string:'';
    });
    $('map-selection').textContent=selected?`${noteName(selected.midi,settings)} · string ${selected.string} · ${selected.fret===0?'open string':'fret '+selected.fret} · ${frequency(selected.midi).toFixed(1)} Hz`:'Choose a colored dot or a string / fret below to connect it to the staff.';
    $('map-hear').textContent=selected?`♫ Hear ${noteName(selected.midi,settings)}`:'♫ Hear note';
    $('map-hear').disabled=!selected||!canHear();
    $('map-audio-help').textContent=canHear()?`${guitarVoiceLabel(getSettings())} · recorded strings. Some upper frets use pitch-adjusted recordings.`:'Guitar sound muted while the microphone is on. Enable headphones in practice to listen.';
  }
  function choosePosition(el){
    if(!el)return;cancelSound();
    selected={string:Number(el.dataset.mapString),fret:Number(el.dataset.mapFret),midi:Number(el.dataset.mapMidi)};updateSelection();
    // Chips remain usable on a small screen; bring their corresponding neck dot into view.
    const dot=$('map-neck').querySelector('[aria-pressed="true"]');
    if(dot){const box=dot.getBoundingClientRect(),scroll=$('map-neck-scroll'),bounds=scroll.getBoundingClientRect();if(box.left<bounds.left+8||box.right>bounds.right-8)scroll.scrollLeft+=box.left-bounds.left-scroll.clientWidth/2;}
  }
  $('map-note').onchange=()=>{cancelSound();pc=Number($('map-note').value);groups=noteMapGroups(pc,settings);octave='all';selected=null;renderOctaves();render();};
  $('map-octaves').onclick=e=>{
    const button=e.target.closest('[data-map-octave]');if(!button)return;cancelSound();octave=button.dataset.mapOctave;selected=null;
    $('map-octaves').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));render();
  };
  for(const id of ['map-neck','map-staves'])$(id).onclick=e=>choosePosition(e.target.closest('[data-map-string][data-map-fret]'));
  $('map-neck').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choosePosition(e.target.closest('[data-map-string][data-map-fret]'));}};
  $('map-hear').onclick=async()=>{
    if(!selected||!canHear())return;cancelSound();const token=generation;
    $('map-hear').setAttribute('aria-busy','true');
    try{await hear(selected,()=>token===generation&&dialog.open&&canHear(),message=>{if(token===generation)$('map-audio-help').textContent=message;});}
    catch{if(token===generation)$('map-audio-help').textContent='Guitar recording could not load. Press Hear to retry.';}
    finally{if(token===generation)$('map-hear').removeAttribute('aria-busy');}
  };
  $('map-guitar-sound').onchange=()=>{cancelSound();onSoundChange('guitarSound',$('map-guitar-sound').value);syncSoundControls();updateSelection();};
  $('map-guitar-touch').onchange=()=>{cancelSound();onSoundChange('guitarTouch',Number($('map-guitar-touch').value));updateSelection();};
  dialog.addEventListener('close',cancelSound);
  document.addEventListener('visibilitychange',()=>{if(dialog.open){if(document.hidden)cancelSound();queueMicrotask(updateSelection);}});
  return {open(note){
    beforeOpen();cancelSound();settings={...getSettings()};pc=mod(note);groups=noteMapGroups(pc,settings);octave='all';selected=null;
    $('map-note').innerHTML=Array.from({length:12},(_,i)=>`<option value="${i}">${pitchClassName(i,settings)}</option>`).join('');$('map-note').value=String(pc);
    syncSoundControls();renderOctaves();render();dialog.showModal();dialog.scrollTop=0;$('map-neck-scroll').scrollLeft=0;$('map-note').focus();
  }};
}
