# Fretwise

A standalone guitar sight-reading and fretboard trainer. Open `index.html` through an HTTP server (ES modules require HTTP) or use the published HTTPS page. It does not use the inventory app, Supabase, accounts, or external audio services.

## Practice

- Defaults to standard tuning, strings 1–6 and frets 0–21. Choosing C includes every available C3, C4, C5 and C6. Register and fret/string filters can narrow practice.
- Four bars of 4/4 in standard guitar treble notation, with count-in, moving playhead, quarter/half/whole notes, editable tempo, looping and a wait-for-input mode.
- The metronome defaults to recordings of a real pendulum metronome, alternating its tick and tock at the score tempo. It has its own volume, an optional first-beat accent, a digital alternative and a four-beat preview. The count-in uses the chosen sound even when the ongoing metronome is off. It follows transport and microphone/headphone muting. If recordings cannot load, a visible status explains the digital fallback; Preview retries the download. See `samples/metronome/README.md` for source and license.
- Note names and frequencies are **sounding pitches**. Guitar staff notation is written an octave higher, shown with an 8 below the treble clef. Accidentals are spelled by the selected scale, reset per bar, and cancel with naturals where needed.
- Circled string numbers are classical guitar location instructions. The pitch plus the assigned string fixes the fret. Equivalent pitches on other strings do not satisfy a fretboard answer.
- Manual self-checks, interactive fretboard checks and optional local microphone pitch/octave/onset detection. The microphone cannot verify physical string choice. It requires HTTPS/localhost and permission; failure leaves manual mode usable. Microphone mode mutes all app audio to prevent feedback, unless the user enables the headphones option. With headphones, metronome, count-in and backing remain audible during microphone checking. Play single notes, damp sustain between repeated pitches, and expect device-dependent latency.
- Start slow, then raise the tempo. At the chosen target BPM, each exact pitch needs at least two clean, unaided passes and four correct occurrences in the chosen rhythm. Manual milestones are self-rated. Wait mode and hinted/revealed answers do not earn milestones. This is practice evidence, not a guarantee of permanent recall or physical-position mastery.
- Recommendations first identify weak/unlearned exact pitches, then choose a nearby unused scale pitch class. Adding a pitch class adds all its available selected octaves. Optional automatic progression adds it between phrases.
- A tonic/fifth drone or bass groove follows key and tempo. Local audio files loop unchanged; no automatic key detection, transposition or tempo stretching is claimed. The chromatic family warns that a fixed-key accompaniment may clash.
- Recorded acoustic drums follow the score's BPM in pop, rock, shuffle and half-time grooves. Kick, snare, closed/open hats, three toms, ride and crash use 24 real recordings with alternate takes and velocity layers. Optional fills finish every four bars. Drum level is independent of the backing, under the master volume. Preview plays four bars without starting practice. Drums start after the count-in, stop with the transport, and respect microphone/headphone muting. The swung subdivision in the shuffle accompanies the score; written quarter/half/whole notes keep their normal beat lengths.
- Samples are a compact CC0 subset of Karoryfer's Big Rusty Drums, mixed with the original room recordings. They are fetched on demand from this site's own assets (about 18.2 MiB); no account, subscription or external audio service is required. See `samples/acoustic/README.md` for source, license and rebuilding instructions. Failed loading offers retry or drums-off practice.
- Setup, completed session summaries and pitch progress are stored in this browser's localStorage. Microphone audio is processed transiently and is never recorded or transmitted. User audio files are used through local object URLs. Network requests by the app are limited to its bundled static drum and metronome samples.

## Run and verify

Serve the repository with a local static server and open `/fretboard/index.html`.

```
node --test tests/fretboard-music.test.mjs tests/fretboard-drums.test.mjs tests/fretboard-metronome.test.mjs tests/fretboard-browser.test.mjs
```

Browser tests use the existing Playwright dependency. Set `PLAYWRIGHT_BROWSERS_PATH` to the installed browser directory where required. Tests cover octave separation, harmonic-rich pitch detection, scale spelling, coverage, string constraints, clean-pass progression, transport, responsive layout, permission denial and microphone input simulated through a real AudioContext. Drum checks validate every bundled recording against its manifest, decode and render real samples through Web Audio, check alternate takes and hi-hat choking, and exercise preview, count-in, loop timing, pause/resume, microphone muting, failed downloads, retry and cancellation. Metronome checks render the recorded clicks, verify alternating samples and accent strength, and exercise four-beat preview timing, saved controls, count-in rules and disclosed fallback/retry.

References: [Yamaha guitar notation and tuning](https://www.yamaha.com/en/musical_instrument_guide/classical_guitar/play/play002.html), [MDN microphone requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
