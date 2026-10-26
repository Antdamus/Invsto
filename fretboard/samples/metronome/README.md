# Recorded pendulum metronome

`tick.wav` and `tock.wav` are alternating clicks from a **physical mechanical pendulum metronome**, recorded by **Joseph SARDIN / BigSoundBank**.

- Source page: https://bigsoundbank.com/metronome-a-120bpm-s0468.html
- Original WAV: https://bigsoundbank.com/UPLOAD/bwf-en/0468.wav
- License: **CC0 1.0 Universal**, included in `LICENSE.txt`. The source page explicitly permits editing and redistribution in apps.
- Source and output checksums, exact excerpt positions: `sources.json`.

The source describes a plastic mechanical metronome at approximately 120 BPM. These are individual recorded clicks, not a loop of the original timing. Fretwise schedules each click on the exercise's precise tempo grid without changing the sound's pitch. A stronger volume on beat one provides the optional bar accent; no bell is added.

Each excerpt lasts 230 ms, with a 1 ms lead-in, a short edge fade and shared peak normalization. Format: mono 48 kHz, 16-bit PCM WAV; both files together are about 44 KB. The app serves them from its own host. No third-party requests are made during practice.

Rebuild with `node tools/prepare-fretboard-metronome.mjs` from the repository root.
