"""Build permanent evidence timelines, independent from visitor-triggered lookups."""
from datetime import date
from html import escape
import json
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

BASE = "https://coolcode.ca/domain-biography/"


def link(href, text):
    return '<a href="'+escape(href,quote=True)+'">'+escape(text)+'</a>'


def render(stage):
    cases = json.loads((stage/"records/cases.json").read_text())
    urls = []
    def save(path,title,summary,content):
        url = BASE+path
        urls.append(url)
        prefix = "../"*path.count("/")
        html = ('<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>'+escape(title)+' · Domain Biography</title><meta name="description" content="'+escape(summary,quote=True)+'">'
                '<link rel="canonical" href="'+url+'"><meta property="og:title" content="'+escape(title,quote=True)+'">'
                '<meta property="og:description" content="'+escape(summary,quote=True)+'"><meta property="og:url" content="'+url+'">'
                '<link rel="stylesheet" href="'+prefix+'style.css"><script defer src="/assets/tool-metrics.js" referrerpolicy="no-referrer"></script>'
                '</head><body data-tool-id="domain-biography"><header>'+link(prefix,"Domain Biography")+' '+link("https://coolcode.ca/","CoolCode.ca")
                +'</header><main><h1>'+escape(title)+'</h1><p>'+escape(summary)+'</p>'+content+'</main></body></html>')
        target = stage/path/"index.html"
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(html)
    directory = []
    for case in cases:
        domain,slug = case["domain"],case["slug"]
        path = "records/"+slug+"/"
        detail = ['<p>'+link("../../?domain="+domain, "Look up "+domain+" now")+'</p><ol>']
        for day,title,note,href in case["events"]:
            date.fromisoformat(day)
            if urlsplit(href).scheme != "https":
                raise ValueError("Source links require HTTPS")
            detail.append('<li><p><time datetime="'+day+'">'+day+'</time> · <strong>'+escape(title)+'</strong></p><p>'
                          +escape(note)+' '+link(href,"Source record")+'</p></li>')
        detail.append('</ol><h2>Reading the evidence</h2><p>'+escape(case["context"])+'</p><p>Sources reviewed November 27, 2026.</p>')
        detail.extend('<p>'+link(url,title)+'</p>' for url,title in case["related"])
        detail.append('<p>'+link("../","Browse the website history case files")+'</p>')
        save(path,case["title"],case["summary"],''.join(detail))
        directory.append('<li><h2>'+link("./"+slug+"/",case["title"])+'</h2><p>'+escape(case["summary"])+'</p></li>')
    save("records/","Website history case files","Explore dated examples of domain registration, archived websites and public decisions. Follow each event to its source.",'<ul>'+''.join(directory)+'</ul>')
    root=ET.Element("urlset",xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")
    for url in urls:
        ET.SubElement(ET.SubElement(root,"url"),"loc").text=url
    (stage/"sitemap.xml").write_bytes(ET.tostring(root,encoding="utf-8",xml_declaration=True))
