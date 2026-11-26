"""Exercise the built tool at a project subpath in Chromium, with every external service served from fixtures."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import shutil
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def fake_network(page, cdx_ok=True, rdap_ok=True):
    def handle(route):
        url = route.request.url
        if "127.0.0.1" in url:
            return route.continue_()
        body = None
        if url.startswith("https://data.iana.org/rdap/dns.json"):
            body = (FIX / "iana-dns.json").read_text()
        elif url.startswith("https://rdap.ca.fury.ca/rdap/domain/"):
            if not rdap_ok:
                return route.fulfill(status=503, body="down")
            name = url.rsplit("/", 1)[1]
            if name != "example-history.ca":
                return route.fulfill(status=404, body="{}", headers={"Access-Control-Allow-Origin": "*"})
            body = (FIX / "rdap-ca.json").read_text()
        elif url.startswith("https://crt.sh/"):
            body = (FIX / "crt.json").read_text()
        elif url.startswith("https://coolcode-visitor-api.jeffdyer.workers.dev/api/domain-biography/archive") or url.startswith("https://web.archive.org/cdx/"):
            if not cdx_ok:
                return route.fulfill(status=503, body="busy")
            body = json.dumps({'data':{'rows':json.loads((FIX/'cdx.json').read_text()),'truncated':False}})
            if 'mode=pages' in url:
                body=json.dumps({'data':{'rows':[['timestamp','original','statuscode','mimetype'],['20000102030405','http://example-history.ca/about.html','200','text/html']],'truncated':False}})
        elif url.startswith("https://archive.org/wayback/available"):
            body = (FIX / ("avail-first.json" if "19960101" in url else "avail-latest.json")).read_text()
        if body is None:
            return route.abort()
        route.fulfill(status=200, body=body, headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"})
    page.route("**/*", handle)


def main():
    screenshots = ROOT / "browser-checks"
    screenshots.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        shutil.copytree(ROOT / "dist", Path(temporary) / "domain-biography")
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=temporary))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}/domain-biography/"
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                page = browser.new_page(viewport={"width": 1280, "height": 1000}, accept_downloads=True)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                fake_network(page)
                page.goto(base)
                assert page.locator("#examples button").count() >= 4

                # A sub-domain URL resolves to its registered parent at the registry.
                page.fill("#domain", "https://WWW.Example-History.ca/some/page")
                page.click("#lookup button[type=submit]")
                page.wait_for_selector("#timeline li.registry")
                assert page.locator("#domain").input_value() == "www.example-history.ca"
                assert "registered name example-history.ca" in page.locator("#sources").inner_text()

                page.fill("#domain", "example-history.ca")
                page.click("#lookup button[type=submit]")
                page.wait_for_function("document.querySelector('#status').textContent.startsWith('Retrieved')")
                labels = page.locator("#timeline li").all_inner_texts()
                assert any("Transferred" in t for t in labels), labels
                assert any("Registration expires" in t for t in labels)
                assert page.locator("#timeline li.future").count() == 1
                assert "2006–2011" in page.locator("#quiet").inner_text()
                assert page.locator("#chart rect.certs").count() == 25
                assert page.locator("#issuers tbody tr").count() == 2
                assert page.locator('#archive-years tbody tr').count()>0
                assert '/about.html' in page.locator('#archive-pages').inner_text()
                assert page.locator('#archive-pages a').first.get_attribute('href').startswith('https://web.archive.org/web/')
                assert page.locator('#ca-history').is_visible()
                assert page.locator('#investigation a').count()==3
                # Registry text containing markup is shown as text.
                assert "<b>Maple</b> Registrar Inc." in page.locator("#registry").inner_text()
                assert page.locator("#registry b").count() == 0
                assert "domain=example-history.ca" in page.url

                with page.expect_download() as dl:
                    page.click("#dl-md")
                assert dl.value.suggested_filename == "example-history.ca-biography.md"
                page.screenshot(path=str(screenshots / "desktop.png"), full_page=True)

                # Shared link reloads the lookup; CDX outage falls back to first/latest captures.
                page2 = browser.new_page()
                page2.on("pageerror", lambda error: errors.append(str(error)))
                fake_network(page2, cdx_ok=False, rdap_ok=False)
                page2.goto(base + "?domain=example-history.ca")
                page2.wait_for_function("document.querySelector('#status').textContent.startsWith('Retrieved')")
                src = page2.locator("#sources").inner_text()
                assert "availability API" in src and "registry: unavailable" in src, src
                assert any("closest available Wayback" in t for t in page2.locator("#timeline li").all_inner_texts())

                assert 'No quiet-period inference' in page2.locator('#quiet').inner_text()
                page.locator('#lookup summary').click()
                page.fill('#from-year','2000');page.fill('#to-year','2004')
                page.click('#lookup button[type=submit]')
                page.wait_for_function("document.querySelector('#status').textContent.startsWith('Retrieved')")
                assert 'from=2000' in page.url and 'to=2004' in page.url
                assert 'Selected years: 2000 to 2004' in page.locator('#archive-note').inner_text()
                # Validation message for an IP address.
                page.fill("#domain", "192.0.2.10")
                page.click("#lookup button[type=submit]")
                assert "not an IP" in page.locator("#status").inner_text()

                page.set_viewport_size({"width": 390, "height": 844})
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
                page.screenshot(path=str(screenshots / "mobile.png"), full_page=True)
                assert not errors, errors
                browser.close()
            print("Browser checks passed: subpath, parent lookup, timeline, quiet periods, safe text, export, fallback and mobile")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
