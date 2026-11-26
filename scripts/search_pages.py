"""Generate crawlable working examples from the same form as the main page."""
from html import escape
import json
import re


def render_pages(stage, tool, pages):
    source = (stage / "index.html").read_text(encoding="utf-8")
    for path, title, description, defaults in pages:
        folder = stage / path
        folder.mkdir(exist_ok=True)
        url = "https://coolcode.ca" + tool["url"] + (path + "/" if path else "")
        page = re.sub(r"<title>.*?</title>", lambda _: "<title>" + escape(title) + " · CoolCode</title>", source, count=1)
        page = re.sub(r'<meta name="description" content="[^"]*">', lambda _: '<meta name="description" content="' + escape(description) + '">', page, count=1)
        page = re.sub(r'<link rel="canonical"[^>]*>|<meta property="og:[^>]*>', "", page)
        head = '<link rel="canonical" href="' + escape(url) + '">'
        for prop, value in (("title", title), ("type", "website"), ("url", url), ("description", description)):
            head += '<meta property="og:' + prop + '" content="' + escape(value) + '">'
        schema = {"@context":"https://schema.org","@type":"WebApplication","name":title,"url":url,"description":description,"operatingSystem":"Any","applicationCategory":"UtilitiesApplication","offers":{"@type":"Offer","price":"0","priceCurrency":"CAD"}}
        page = page.replace("</head>", head + '<script type="application/ld+json">' + json.dumps(schema).replace("<", "\\u003c") + "</script></head>", 1)
        if path:
            page = re.sub(r'((?:href|src)=")\./', r'\1../', page)
            page = re.sub(r"(<h1(?: [^>]*)?>).*?</h1>", lambda m: m[1] + escape(title) + "</h1>", page, count=1, flags=re.S)
            page = page.replace("<!-- example-intro -->", '<p class="example-intro">' + escape(description) + '</p>', 1)
            attrs = "".join(' data-' + key + '="' + escape(value) + '"' for key, value in defaults.items())
            page = page.replace("<body", "<body" + attrs, 1)
        if defaults.get("domain") == "cira.ca":
            evidence = '<p class="small">CIRA’s registry returned a registration date of 5 February 1998 for cira.ca, checked 26 November 2026 UTC. <a href="https://rdap.ca.fury.ca/rdap/domain/cira.ca">Inspect the registry record</a>.</p>'
            page = page.replace('<h2 id="lookup-title">Look up a domain</h2>', '<h2 id="lookup-title">Look up a domain</h2>' + evidence)
        (folder / "index.html").write_text(page, encoding="utf-8")

PAGES = [('',
  'Website History & Domain Check',
  'Check when a domain was registered, inspect past versions of its website and compare dated '
  'evidence before trusting an unfamiliar site.',
  {}),
 ('canadian-domain-history',
  'Check a Canadian Domain’s History',
  'Explore cira.ca using current registry records, dated certificates and archived pages. The .ca '
  'registry can withhold personal contact details. First observed archive dates can differ from '
  'registration dates.',
  {'domain': 'cira.ca'})]
