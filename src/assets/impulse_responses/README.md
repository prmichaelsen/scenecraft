# Impulse Responses (placeholders)

The 6 WAV files in this directory are **synthesized placeholders** shipped
with M13 task-47 so the ConvolverNode-based reverb buses have something to
load during development.

Generation: `npm run gen:ir` (runs `generate.mjs`). Each file is
exponentially-decaying white noise passed through a 1-pole low-pass, at
22050 Hz / 16-bit mono. Seeded PRNG so bytes are reproducible across builds.

| File            | Character               | Decay | LP cutoff | Pre-delay |
|-----------------|-------------------------|-------|-----------|-----------|
| room-small.wav  | tight room              | 0.35s | 4.5 kHz   | 3 ms      |
| room-large.wav  | medium room             | 0.8s  | 4.2 kHz   | 8 ms      |
| hall.wav        | long concert hall       | 1.8s  | 3.5 kHz   | 20 ms     |
| plate.wav       | bright, instant onset   | 1.2s  | 7.0 kHz   | 0 ms      |
| spring.wav      | short, mid-forward      | 0.6s  | 5.5 kHz   | 2 ms      |
| chamber.wav     | medium chamber          | 1.0s  | 4.0 kHz   | 10 ms     |

## TODO: replace with real IRs

These are audibly *passable* as reverb IRs but not sourced from real rooms.
A later task should swap them for CC-licensed captures (e.g. OpenAIR,
EchoThief) or in-house recordings. Spec target (R53): total gzipped bundle
≤ 200 KB. Current uncompressed total is ~255 KB.
