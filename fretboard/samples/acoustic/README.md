# Fretwise acoustic kit

24 recorded hits adapted from **Big Rusty Drums**, by **Karoryfer Samples**.

- Library: https://shop.karoryfer.com/pages/free-big-rusty-drums
- Source repository: https://github.com/sfzinstruments/karoryfer.big-rusty-drums
- Revision: `f07ce00df34a46b6b08375be56fe116cf15782bc`
- License: **CC0 1.0 Universal**, copied unchanged in `LICENSE.txt`.
- Exact source URLs and SHA-256 checksums: `sources.json`.

Includes a 24-inch kick, 14-inch snare, closed and partly open hi-hat, 14/15/18-inch toms, 22-inch ride and 17-inch crash. Each articulation has two alternate recorded takes. Kick, snare and closed hats also have two velocity layers.

Each browser sample combines the close microphone with the original stereo overhead recording at 30%, preserving room sound. Peak levels are balanced per instrument across both velocity layers and takes; leading near-silence is trimmed while keeping a 1 ms lead-in. Files are 44.1 kHz, 16-bit stereo PCM WAV, preserving the natural tails. The 24 samples total about 18.2 MiB and load on demand from the same host as the app. No third-party audio service is contacted during practice.

Reproduce with Node and ffmpeg: `node tools/prepare-fretboard-drums.mjs` from the repository root. The preparation script downloads only the selected source recordings and license. Source downloads and intermediate mixes go in ignored `test-results/drum-source/`.
