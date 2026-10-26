import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULTS,TUNING} from '../fretboard/music.mjs';
import {noteMapGroups,staffGeometry} from '../fretboard/note-map.mjs';

test('C map includes every exact octave and all eleven locations on a 21-fret guitar',()=>{
  const groups=noteMapGroups(0);
  assert.deepEqual(groups.map(g=>[g.name,g.writtenName,g.midi]),[['C3','C4',48],['C4','C5',60],['C5','C6',72],['C6','C7',84]]);
  assert.deepEqual(groups.map(g=>g.positions.map(p=>[p.string,p.fret])),[
    [[5,3],[6,8]],[[2,1],[3,5],[4,10],[5,15],[6,20]],[[1,8],[2,13],[3,17]],[[1,20]]
  ]);
});

test('all twelve note maps partition the complete physical neck regardless of practice filters',()=>{
  const restricted={...DEFAULTS,pool:[0],strings:[1],minFret:5,maxFret:7,octaves:[4]},all=[];
  for(let pc=0;pc<12;pc++){
    const groups=noteMapGroups(pc,restricted);
    assert.deepEqual(groups,noteMapGroups(pc));
    for(const g of groups)for(const p of g.positions){
      assert.equal(p.midi,TUNING[p.string-1]+p.fret);assert.equal(p.midi%12,pc);assert.equal(g.midi,p.midi);all.push(`${p.string}:${p.fret}`);
    }
  }
  const expected=TUNING.flatMap((_,i)=>Array.from({length:22},(_,f)=>`${i+1}:${f}`));
  assert.equal(all.length,132);assert.deepEqual(all.sort(),expected.sort());
});

test('notation uses written guitar pitch, exact ledger lines and key-aware spelling at octave boundaries',()=>{
  assert.equal(staffGeometry(65).y,72); // Sounding F4 is written F5, the top staff line.
  assert.deepEqual(staffGeometry(40).ledgers,[142,156,170]); // Sounding low E2 is written E3.
  assert.deepEqual(staffGeometry(84).ledgers,[58,44,30,16,2]);
  const cFlat=noteMapGroups(11,{...DEFAULTS,root:8,scale:'minor'});
  assert.deepEqual(cFlat.map(g=>g.name),['C♭3','C♭4','C♭5','C♭6']);
  assert.equal(cFlat[0].midi,47); // B2 is spelled C-flat 3 in A-flat minor.
  assert.equal(staffGeometry(47,{...DEFAULTS,root:8,scale:'minor'}).y,142);
  const flat=noteMapGroups(10,{...DEFAULTS,root:5});
  assert.ok(flat.every(g=>g.name.startsWith('B♭')));
  assert.equal(staffGeometry(70,{...DEFAULTS,root:5}).written.acc,-1);
  const eSharp=noteMapGroups(5,{...DEFAULTS,root:6});
  assert.deepEqual(eSharp.map(g=>g.name),['E♯2','E♯3','E♯4','E♯5']);
  assert.equal(staffGeometry(41,{...DEFAULTS,root:6}).written.acc,1);
});
