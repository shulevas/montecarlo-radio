"""Smoke test in headless Chromium against the real stream.

Measures the signal level right after our GainNode at several dB values,
then checks compatibility mode plays too.

Usage: .venv/bin/python tools/check.py [URL]   (default http://localhost:8765/)
"""
import math
import pathlib
import sys
import time
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
CHROME = pathlib.Path.home() / ".cache/ms-playwright/chromium-1194/chrome-linux/chrome"

# Tap the output: whenever a GainNode connects to the destination, also feed an analyser.
TAP = """
(() => {
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = orig.call(this, dest, ...rest);
    if (this instanceof GainNode && dest instanceof AudioDestinationNode) {
      const an = this.context.createAnalyser();
      an.fftSize = 2048;
      orig.call(this, an);
      window.__tap = an;
    }
    return r;
  };
  window.__rms = () => {
    const an = window.__tap; if (!an) return null;
    const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length);
  };
})();
"""


def avg_rms(page, seconds=3.0):
    vals = []
    end = time.time() + seconds
    while time.time() < end:
        v = page.evaluate("window.__rms()")
        if v is not None:
            vals.append(v)
        time.sleep(0.1)
    return sum(vals) / len(vals) if vals else 0.0


def db(x):
    return 20 * math.log10(x) if x > 0 else float("-inf")


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=str(CHROME) if CHROME.exists() else None,
        args=["--autoplay-policy=no-user-gesture-required"],
    )
    page = browser.new_page()
    page.add_init_script(TAP)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.reload()

    page.click("#play")
    page.wait_for_function("window.__radio.state.status === 'playing'", timeout=20000)
    print("web audio:", page.evaluate("window.__radio.state"))
    time.sleep(2)

    results = {}
    for level in (0, -20, -40, -60):
        page.evaluate(f"v => {{ const s = document.getElementById('vol'); s.value = v; s.dispatchEvent(new Event('input')); }}", level)
        time.sleep(0.5)
        results[level] = avg_rms(page)
        print(f"  slider {level:>4} dB -> rms {results[level]:.6f} ({db(results[level]):6.1f} dBFS), label {page.text_content('#vol-value')}")
    drop = db(results[0]) - db(results[-60])
    print(f"  0 dB vs -60 dB: {drop:.1f} dB quieter")
    page.screenshot(path="/tmp/mc-playing.png")

    # persistence
    page.reload()
    print("  after reload volume:", page.evaluate("window.__radio.state.volDb"))

    # compatibility mode
    page.click("#play")
    page.wait_for_function("window.__radio.state.status === 'playing'", timeout=20000)
    page.click("#compat")
    page.wait_for_function("window.__radio.state.mode === 'compat' && window.__radio.state.status === 'playing'", timeout=20000)
    st = page.evaluate("window.__radio.state")
    print("compat:", st)

    # pause / resume
    page.click("#play")
    print("after pause:", page.evaluate("window.__radio.state.status"))
    page.click("#play")
    page.wait_for_function("window.__radio.state.status === 'playing'", timeout=20000)
    print("after resume:", page.evaluate("window.__radio.state.status"))

    page.emulate_media(color_scheme="dark")
    page.screenshot(path="/tmp/mc-dark.png")
    print("page errors:", errors or "none")
    browser.close()

ok = drop > 50 and not errors
print("RESULT:", "OK" if ok else "FAIL")
sys.exit(0 if ok else 1)
