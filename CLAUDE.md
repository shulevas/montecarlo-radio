# montecarlo-radio

Telegram Mini App: one-screen player for Radio Monte Carlo Cyprus. Static HTML/CSS/JS, no build, deployed to GitHub Pages from `main` (root).

- Stream: `https://live.vblcast.com/proxy/montecarlo/stream` (Shoutcast MP3 128k, `Access-Control-Allow-Origin: *`). Found on https://montecarlo.cy/live/.
- Volume goes through Web Audio (MediaElementSource -> GainNode) because iOS ignores `audio.volume`. Slider is linear in dB, -60..0.
- Compatibility mode = plain `<audio>`, no Web Audio.
- Tests: `.venv/bin/python tools/check.py` against `python3 -m http.server 8765` (real stream, measures level after GainNode). venv is local, not in git: `python3 -m venv .venv && .venv/bin/pip install playwright pillow`. Chromium from `~/.cache/ms-playwright/chromium-1194`.
- Icons: edit `icon.svg`, then `.venv/bin/python tools/render_icons.py`.
- Public repo: commits with the GitHub noreply email.
