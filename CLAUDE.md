# montecarlo-radio

Telegram Mini App: one-screen player for Radio Monte Carlo Cyprus. Static HTML/CSS/JS, no build, deployed to GitHub Pages from `main` (root).

- Stream: `https://live.vblcast.com/proxy/montecarlo/stream` (Shoutcast MP3 128k, `Access-Control-Allow-Origin: *`). Found on https://montecarlo.cy/live/.
- Default mode: plain `<audio>`, volume = phone buttons (iOS ignores `audio.volume`).
- Manual volume switch ("quiet mode" in code): fetch() the stream, split MP3 frames, decodeAudioData in 19-frame pieces with 4 frames of overlap, schedule AudioBufferSources -> GainNode. Level 100%..3%, log slider. MediaElementSource -> GainNode was tried first and had no effect on a real iPhone with this live stream, do not go back to it.
- iOS needs both: a silent looping `<audio>` started in the tap (else Web Audio is ambient: silent switch, background) and a context at the hardware rate (pieces go through our own continuous resampler; browser resampling clicked at seams). Works on iPhone (Home Screen app, 2026-11-26).
- Shoutcast sends a ~12-17 s burst on connect, so quiet mode normally runs that far ahead of "now".
- Tests: `.venv/bin/python tools/check.py` against `python3 -m http.server 8765` (real stream, measures level after GainNode). venv is local, not in git: `python3 -m venv .venv && .venv/bin/pip install playwright pillow`. Chromium from `~/.cache/ms-playwright/chromium-1194`.
- Icons: edit `icon.svg`, then `.venv/bin/python tools/render_icons.py`.
- Public repo: commits with the GitHub noreply email.
