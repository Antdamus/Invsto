# Recorded guitars

These are unmodified web OGG recordings from [Meta Open Sound](https://github.com/facebookincubator/Meta-open-sound), by Meta Creative Audio, released under CC0-1.0. Both collections include their original license. Revision: `251c0be57d5d1b3242b91f53e0cde62ab1cb42d9`.

- Steel: 375 recordings, 125 string/pitch positions with soft, medium and firm layers; about 24.75 MiB.
- Nylon: 348 recordings, 116 positions with fingerstyle, light pick and firm pick layers; about 16.04 MiB.

The original mono OGG files retain the recorded attack and full natural decay; they are not synthesized tones or the larger stereo source WAVs. Every bundled file is checked against the publisher's SHA256SUMS. The `sources-*.json` manifests record source URL, pitch, string, layer, byte length and hash for reproducibility. Rebuild with `node tools/prepare-fretboard-guitars.mjs`.

Playback loads the requested recording only, caches up to 24 decoded buffers, and releases the previous note on that string with a 60 ms fade. Other strings may ring together. Master and guitar levels apply independently. No pitch jitter or invented round-robin takes are used. The synthesized drone/bass accompaniment is separate from these guitar previews.

The physical study map has frets 0–21. Steel recordings cover frets 0–20, except missing B2 on string 6; those seven uncovered positions use a recording from the same string shifted one semitone. Nylon reaches fret 19 on strings 1/6 and fret 18 on strings 2–5; its upper positions need up to three semitones of adjustment. The player discloses adjustment after playback. Practice ranges beyond fret 21 also use the closest recorded pitch on that string. These recordings do not reproduce every technique or the exact sound of the user's instrument.

Source specifications: [steel](https://github.com/facebookincubator/Meta-open-sound/tree/251c0be57d5d1b3242b91f53e0cde62ab1cb42d9/systems/instruments/meta-steel-guitar), [nylon](https://github.com/facebookincubator/Meta-open-sound/tree/251c0be57d5d1b3242b91f53e0cde62ab1cb42d9/systems/instruments/meta-nylon-guitar).
