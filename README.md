# Radio Monte Carlo Limassol · web player

A one-screen player for the live stream of Radio Monte Carlo Limassol (104.5 FM, Cyprus). Works as a Home Screen app on iPhone, in any browser, and as a Telegram Mini App.

Live page: https://shulevas.github.io/montecarlo-radio/

Unofficial. Not affiliated with the station; it only plays the public stream from https://montecarlo.cy/live/.

## What it does

- Play / pause, status (connecting, live, buffering, reconnecting).
- Now playing: song and artist, refreshed every 15 s while listening, also shown on the lock screen.
- Lock screen / Control Center controls via Media Session (song, artist, artwork, play/pause).
- Auto-reconnect when the stream drops (backoff 0.5 s → 15 s, watchdog for frozen streams, instant retry when the network comes back).
- One dark look in the station's colours: bottle green, a gunmetal play button with a gold light orbiting its rim while live.
- Volume: the phone's own buttons.

## Install on iPhone Home Screen

1. Open https://shulevas.github.io/montecarlo-radio/ in Safari.
2. Share → Add to Home Screen → Add.
3. It opens full screen with its own icon, like an app.

## Sources

- Stream: `https://live.vblcast.com/proxy/montecarlo/stream` (Shoutcast, MP3 128 kbps), found on the station's live page.
- Now playing: the Centova Cast endpoint `https://live.vblcast.com/external/rpc.php?m=streaminfo.get&username=montecarlo&rid=montecarlo`. It sends `Access-Control-Allow-Origin: *`; the Shoutcast `stats` / `currentsong` endpoints do not, and the stream refuses the preflight needed for in-stream ICY metadata.
- The server double-encodes titles (UTF-8 read as Windows-1252, "BEYONCÃ‰"); `app.js` reverses that. Titles arrive in capitals and are shown in title case.

## Volume slider (hidden)

The page has a Web Audio volume slider in dB (−60…0) behind `FEATURE_VOLUME` in `app.js`. It works in desktop browsers, but on an iPhone it had no effect on this live stream, so it is off and playback uses a plain `<audio>`. Web pages cannot read or set the iPhone's system volume.

## Telegram (optional)

The same page opens as a Mini App: in [@BotFather](https://t.me/BotFather) `/newbot`, then `/mybots` → the bot → Bot Settings → Menu Button → Configure menu button → the URL above. No bot token is needed by the page.

## iPhone checklist

- [ ] Opens from the Home Screen icon full screen, header area green.
- [ ] Play starts within a few seconds, status shows "Live", song and artist appear.
- [ ] Song changes on screen and on the lock screen within ~15 s of the radio switching tracks.
- [ ] Lock the screen: keeps playing for 5+ minutes; lock screen shows song, artist and the icon (no white corners); pause and play there work.
- [ ] Switch to another app: keeps playing.
- [ ] Airplane mode for ~10 s, then off: reconnecting, then plays again by itself.
- [ ] The gold light runs smoothly around the button rim; the phone does not get warm.

## Develop

No build. Serve the folder and open it:

```
python3 -m http.server 8765
```

Smoke test in headless Chromium against the real stream and now-playing API:

```
python3 -m venv .venv && .venv/bin/pip install playwright pillow
.venv/bin/python tools/check.py
```

Icons: edit `icon.svg`, then `.venv/bin/python tools/render_icons.py` (makes the rounded icons, plus full-bleed squares for iOS and the lock screen).
