"""Smoke test in headless Chromium against the real stream and now-playing API.

Checks: plays, shows the current song, puts it into Media Session (lock screen),
pause / resume, no page errors.

Usage: .venv/bin/python tools/check.py [URL]   (default http://localhost:8765/)
"""
import pathlib
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
CHROME = pathlib.Path.home() / ".cache/ms-playwright/chromium-1194/chrome-linux/chrome"

ok = True


def check(name, cond, detail=""):
    global ok
    ok = ok and bool(cond)
    print(f"  [{'ok' if cond else 'FAIL'}] {name} {detail}")


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=str(CHROME) if CHROME.exists() else None,
        args=["--autoplay-policy=no-user-gesture-required"],
    )
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)

    check("volume and compat UI hidden",
          page.locator(".volume").is_hidden() and page.locator(".compat").is_hidden())

    page.wait_for_function("!document.getElementById('now').hidden", timeout=15000)
    title, artist = page.text_content("#now-title"), page.text_content("#now-artist")
    check("now playing shown before play", title, f"-> {artist} / {title}")

    page.click("#play")
    page.wait_for_function("window.__radio.state.status === 'playing'", timeout=20000)
    st = page.evaluate("window.__radio.state")
    check("plays via plain <audio>", st["mode"] == "compat" and not st["paused"], str(st))
    check("full volume", page.evaluate("window.__radio.audio.volume") == 1)

    md = page.evaluate("(() => { const m = navigator.mediaSession.metadata; return m && [m.title, m.artist, m.artwork.length]; })()")
    check("lock screen metadata = current song", md and md[0] == title and md[1] == artist, str(md))
    page.screenshot(path="/tmp/mc-playing.png")

    page.click("#play")
    check("pause", page.evaluate("window.__radio.state.status") == "idle")
    page.click("#play")
    page.wait_for_function("window.__radio.state.status === 'playing'", timeout=20000)
    check("resume", True)

    check("no page errors", not errors, str(errors))
    browser.close()

print("RESULT:", "OK" if ok else "FAIL")
sys.exit(0 if ok else 1)
