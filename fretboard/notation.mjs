import {TUNING} from './music.mjs?v=5';

// Count the exact pitch across the whole 21-fret instrument, not practice filters.
export function needsStringNumber(midi){
  return TUNING.filter(base=>midi>=base&&midi<=base+21).length>1;
}

// Keep the circled string about five pixels from the notehead, opposite its stem.
// Its opaque background keeps any staff line behind the number from obscuring it.
export function stringMarkerY(noteY){
  return noteY+(noteY>=100?21:-21);
}
