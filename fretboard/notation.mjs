// Keep the circled string about five pixels from the notehead, opposite its stem.
// Its opaque background keeps any staff line behind the number from obscuring it.
export function stringMarkerY(noteY){
  return noteY+(noteY>=100?21:-21);
}
