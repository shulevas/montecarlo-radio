"""Smoke test in headless Chromium against the real stream and now-playing API.

Checks: plain mode plays, shows the current song, puts it into Media Session (lock screen),
pause / resume; quiet mode plays through its own decoder, the level slider changes the output
by ~30 dB between 100 % and 3 %, no buffer underruns, settings survive a reload; no page errors.

Usage: .venv/bin/python tools/check.py [URL]   (default http://localhost:8765/)
"""
import math
import pathlib
import statistics
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
CHROME = pathlib.Path.home() / ".cache/ms-playwright/chromium-1194/chrome-linux/chrome"

ok = True


def check(name, cond, detail=""):
    global ok
    ok = ok and bool(cond)
    print(f"  [{'ok' if cond else 'FAIL'}] {name} {detail}")


# RMS of the quiet-mode output (after the GainNode) over `ms`
RMS_JS = """(ms) => new Promise((res) => {
  const r = window.__radio, an = r.ctx.createAnalyser();
  an.fftSize = 2048; r.gainNode.connect(an);
  const buf = new Float32Array(an.fftSize); let sum = 0, n = 0;
  const t = setInterval(() => { an.getFloatTimeDomainData(buf); for (const v of buf) { sum += v * v; n++; } }, 40);
  setTimeout(() => { clearInterval(t); r.gainNode.disconnect(an); res(Math.sqrt(sum / n)); }, ms);
})"""


def set_level(page, pct):
    # slider position for a gain: same log mapping as app.js
    pos = 100 * (1 - math.log(pct / 100) / math.log(0.03))
    page.evaluate("(v) => { const s = document.getElementById('vol'); s.value = v; s.dispatchEvent(new Event('input')); }",
                  str(round(pos)))


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=str(CHROME) if CHROME.exists() else None,
        args=["--autoplay-policy=no-user-gesture-required"],
    )
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)

    check("quiet toggle visible, level hidden",
          page.locator(".compat").is_visible() and page.locator(".volume").is_hidden())

    page.wait_for_function("!document.getElementById('now').hidden", timeout=15000)
    title, artist = page.text_content("#now-title"), page.text_content("#now-artist")
    check("now playing shown before play", title, f"-> {artist} / {title}")

    # ---- plain mode ----
    page.click("#play")
    page.wait_for_function("window.__radio.state.status === 'playing'", timeout=20000)
    st = page.evaluate("window.__radio.state")
    check("plain: plays via <audio>", st["mode"] == "plain" and not st["paused"], str(st))

    md = page.evaluate("(() => { const m = navigator.mediaSession.metadata; return m && [m.title, m.artist, m.artwork.length]; })()")
    check("lock screen metadata = current song", md and md[0] == title and md[1] == artist, str(md))

    page.click("#play")
    check("plain: pause", page.evaluate("window.__radio.state.status") == "idle")

    # ---- quiet mode ----
    page.click("#quiet")
    check("quiet: level slider shown", page.locator(".volume").is_visible())
    page.click("#play")
    page.wait_for_function("window.__radio.state.status === 'playing'", timeout=20000)
    st = page.evaluate("window.__radio.state")
    check("quiet: plays through own decoder, no <audio>", st["mode"] == "quiet" and st["paused"] is None
          and st["ctx"] == "running", str(st))

    ratios = []
    for _ in range(3):
        set_level(page, 100)
        page.wait_for_timeout(300)
        loud = page.evaluate(RMS_JS, 1500)
        set_level(page, 3)
        page.wait_for_timeout(300)
        soft = page.evaluate(RMS_JS, 1500)
        if loud > 0 and soft > 0:
            ratios.append(20 * math.log10(soft / loud))
    med = statistics.median(ratios) if ratios else 0
    check("quiet: 3 % is ~30 dB below 100 %", -36 < med < -24, f"-> {[round(r, 1) for r in ratios]} dB")
    check("quiet: label shows 3.0%", page.text_content("#vol-value") == "3.0%", page.text_content("#vol-value"))

    set_level(page, 25)
    page.wait_for_timeout(15000)
    st = page.evaluate("window.__radio.state")
    check("quiet: 15 s without underruns or dropped pieces, buffer ahead",
          st["underruns"] == 0 and st["dropped"] == 0 and st["lead"] > 0.3, str(st))
    page.screenshot(path="/tmp/mc-quiet.png")

    page.click("#play")
    check("quiet: pause", page.evaluate("window.__radio.state.status") == "idle")

    page.wait_for_timeout(600)   # let the debounced save land
    page.reload()
    st = page.evaluate("window.__radio.state")
    check("quiet mode and level survive reload",
          st["quiet"] and abs(st["quietGain"] - 0.25) < 0.02 and page.is_checked("#quiet"), str(st))

    page.click("#play")
    page.wait_for_function("window.__radio.state.status === 'playing'", timeout=20000)
    check("quiet: plays after reload", True)

    # switch back to plain while playing
    page.click("#quiet")
    page.wait_for_function("window.__radio.state.status === 'playing' && window.__radio.state.mode === 'plain'",
                           timeout=20000)
    check("toggle off while playing -> plain <audio>", not page.evaluate("window.__radio.state.paused"))
    page.click("#play")

    check("no page errors", not errors, str(errors))
    browser.close()

print("RESULT:", "OK" if ok else "FAIL")
