# Monte Carlo Cyprus · Mini App

A one-screen Telegram Mini App that plays the live stream of Radio Monte Carlo Cyprus. Built for background listening on iPhone, including very quiet levels.

Live page: https://shulevas.github.io/montecarlo-radio/

Unofficial. Not affiliated with the station; it only plays the public stream from https://montecarlo.cy/live/.

## What it does

- Play / pause, status (connecting, live, buffering, reconnecting).
- Volume slider in dB from −60 dB (barely audible) to 0 dB, plus −/+ buttons for 1 dB steps. The value is remembered (localStorage and Telegram CloudStorage).
- Lock screen / Control Center controls via Media Session (title, artwork, play/pause).
- Auto-reconnect when the stream drops (backoff 0.5 s → 15 s, watchdog for frozen streams, instant retry when the network comes back).
- Follows the Telegram theme (light/dark); works in a normal browser too.
- Compatibility mode: plain `<audio>` without Web Audio.

## How the volume works

iOS ignores `audio.volume` (it is always 1). So the stream goes through Web Audio:

```
<audio crossorigin="anonymous"> -> MediaElementSource -> GainNode -> destination
```

The slider is linear in decibels, so it is logarithmic in amplitude: two thirds of its travel is below −20 dB, where fine control matters when listening quietly. Gain = 10^(dB/20), changed with a 30 ms ramp so it never clicks.

This needs CORS on the stream, otherwise Web Audio outputs silence. The stream `https://live.vblcast.com/proxy/montecarlo/stream` (Shoutcast, MP3 128 kbps) sends `Access-Control-Allow-Origin: *`, so no proxy is needed. If that ever changes, the volume will go silent in normal mode: switch on compatibility mode and see "If CORS disappears" below.

In compatibility mode there is no Web Audio, so on iPhone only the system volume works (the slider is disabled there). On desktop and Android the slider still works through `audio.volume`.

## Set up the bot (BotFather)

1. In Telegram open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name (e.g. `Monte Carlo Radio`) and a username ending in `bot`. Keep the token to yourself; this app does not need it.
2. Menu button: `/mybots` → your bot → Bot Settings → Menu Button → Configure menu button → send the URL `https://shulevas.github.io/montecarlo-radio/` → send a title, e.g. `Radio`.
3. Optional, an "Open" button in the bot profile and a direct link: `/mybots` → your bot → Bot Settings → Configure Mini App → Enable Mini App → same URL.
4. Optional, a `t.me/<bot>/<app>` link: `/newapp` → choose the bot → title, description, a 640×360 picture → URL as above → short name (e.g. `radio`).
5. Open the bot chat, tap the menu button. Pin the chat to reach it faster.

## iPhone checklist

Do each block in normal mode first, then with compatibility mode on.

- [ ] Opens from the menu button, colours match the Telegram theme (try light and dark).
- [ ] Play starts within a few seconds, status shows "Live".
- [ ] Normal mode: moving the slider changes loudness smoothly all the way down to −60 dB (almost silent); −/+ buttons change it by 1 dB.
- [ ] Close the Mini App and open it again: volume and mode are remembered.
- [ ] Minimise the Mini App (swipe it down to the bar): keeps playing.
- [ ] Switch to another app: keeps playing.
- [ ] Lock the screen: keeps playing for 5+ minutes; lock screen shows "Monte Carlo Cyprus" with the icon; pause and play from the lock screen work.
- [ ] Silent switch on: still plays.
- [ ] Airplane mode for ~10 s, then off: status shows reconnecting, then plays again by itself.
- [ ] Interruption (call, Siri, a voice message in Telegram): after it, return to the app; it resumes or one tap resumes it.
- [ ] Compatibility mode: slider disabled with a hint, phone volume buttons work; background and lock screen same as above.

If normal mode goes silent when the screen locks but compatibility mode keeps playing, use compatibility mode for locked listening and set a low system volume.

## If CORS disappears

Options, from simplest:

- Compatibility mode only: zero setup, but on iPhone only system volume.
- Cloudflare Worker proxy that adds `Access-Control-Allow-Origin`: free tier, ~20 lines, low latency; needs a Cloudflare account, and long-lived streams count against Worker limits.
- Small VPS with nginx `proxy_pass` + header: full control, no limits; costs money and needs upkeep.

Then change `STREAM` in `app.js`.

## Develop

No build. Serve the folder and open it:

```
python3 -m http.server 8765
```

Smoke test in headless Chromium against the real stream (measures the level after the GainNode at 0/−20/−40/−60 dB, checks persistence, compatibility mode, pause/resume):

```
python3 -m venv .venv && .venv/bin/pip install playwright pillow
.venv/bin/python tools/check.py
```

Icons: edit `icon.svg`, then `.venv/bin/python tools/render_icons.py`.

Files: `index.html`, `style.css`, `app.js`, `icon.svg`, `icon-192.png`, `icon-512.png`.
