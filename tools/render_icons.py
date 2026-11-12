"""Render icon.svg into the PNGs used by Media Session, the web manifest and iOS Home Screen.

Rounded icons (icon-192/512) keep transparent corners. iOS (apple-touch-icon) and Android
maskable icons must be full-bleed squares: the OS rounds them itself.

Usage: .venv/bin/python tools/render_icons.py
"""
import pathlib
import re
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHROME = pathlib.Path.home() / ".cache/ms-playwright/chromium-1194/chrome-linux/chrome"
svg = (ROOT / "icon.svg").read_text()
square = re.sub(r'rx="\d+"', 'rx="0"', svg, count=1)

TARGETS = [
    ("icon-192.png", 192, svg, True),
    ("icon-512.png", 512, svg, True),
    ("apple-touch-icon.png", 180, square, False),
    ("icon-maskable-512.png", 512, square, False),
]

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=str(CHROME) if CHROME.exists() else None)
    for name, size, src, transparent in TARGETS:
        page = browser.new_page(viewport={"width": size, "height": size})
        page.set_content(
            f'<style>html,body{{margin:0;background:transparent}}svg{{width:{size}px;height:{size}px;display:block}}</style>{src}'
        )
        page.screenshot(path=str(ROOT / name), omit_background=transparent)
        page.close()
    browser.close()
print("ok")
