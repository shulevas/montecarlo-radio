"""Render icon.svg into the PNG sizes used by Media Session and apple-touch-icon.

Usage: .venv/bin/python tools/render_icons.py
"""
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHROME = pathlib.Path.home() / ".cache/ms-playwright/chromium-1194/chrome-linux/chrome"
svg = (ROOT / "icon.svg").read_text()

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=str(CHROME) if CHROME.exists() else None)
    for size in (192, 512):
        page = browser.new_page(viewport={"width": size, "height": size})
        page.set_content(
            f'<style>html,body{{margin:0;background:transparent}}svg{{width:{size}px;height:{size}px;display:block}}</style>{svg}'
        )
        page.screenshot(path=str(ROOT / f"icon-{size}.png"), omit_background=True)
        page.close()
    browser.close()
print("ok")
