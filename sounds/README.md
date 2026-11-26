# Custom sounds (optional)

By default every sound is synthesized in code (`renderer/audio.js`), so this folder can stay empty.

To use your own recordings, put the files here and create `sounds.json`:

```json
{
  "dice": "dice-roll.ogg",
  "step": ["step1.wav", "step2.wav", "step3.wav"],
  "punch": "punch.mp3",
  "whoosh": "whoosh.ogg"
}
```

When a name lists several files, one is picked at random each time. Any sound not listed keeps the built-in synth.
Note that the die animation lasts about 0.9 s, so a dice recording should land around then.
