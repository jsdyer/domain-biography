# Domain Biography

Follow a domain's life on one timeline, at **https://coolcode.ca/domain-biography/**: when it was registered, transferred and changed at the registry, when certificates were first and last issued (and by whom), when the Wayback Machine first and last captured it, and the quiet years in between.

| Source | What it adds | How |
|---|---|---|
| IANA RDAP bootstrap, then the registry's RDAP service (CIRA for .ca) | Registration, transfer, last-changed and expiry events; registrar; status; nameservers; DNSSEC | Live, from your browser |
| crt.sh certificate transparency search | First and latest logged certificates, certificates per year, each issuer's first and last use | Live, from your browser |
| Internet Archive Wayback CDX (falls back to the availability API) | Observed homepage captures by year, earliest/latest returned responses and old about/contact paths | Through a bounded CoolCode gateway; availability fallback from your browser |

## Reading the results

<!-- coolcode:guide -->
Compare dated registry events, archived homepage captures and certificate history for a website. Start with the Canadian domain example or enter a hostname.
Follow the TrueNorth.bet timeline from archived pages to Kahnawà:ke’s decisions, or compare CIRA.ca’s registration with a preserved homepage. Each case cites dated evidence and links back to the editable lookup.
<!-- /coolcode:guide -->

The [Canadian domain history example](https://coolcode.ca/domain-biography/canadian-domain-history/) opens the same editable investigation with cira.ca selected. Pasting a website URL uses its hostname. Compare archive observations with registry events and check the business separately before paying.

Enter a domain such as cira.ca, or paste a full URL. Compare its current registry dates with dated archive observations and certificate history. The archive section counts actual successful HTML responses at the exact homepage, and lists archived about/contact pages to inspect. For a busy site, narrow the optional year range; capped counts are labelled lower bounds. Capture dates are not registration or launch dates, and a gap is not proof of inactivity. Continue to Scan Receipt, Scam Trace or Corporate Ghosts for different investigation questions. Copy the dated-range lookup link or export the results as Markdown/JSON.


- **RDAP shows the registry's current record.** Earlier registrars and owners appear only if an event (such as a transfer) records them, and registries publish different event types. "Registry record changed" can mean any update, such as nameservers, status or contacts.
- **Certificate logs** begin around 2013, and many older sites never used TLS. By default only certificates naming the domain itself are counted. Tick **Include subdomain certificates** to add `%.domain`; large sites can return tens of thousands of rows and may time out.
- **Archive counts are observed successful HTML homepage responses**, not every page, every subdomain, visits, or unique versions. The gateway allows at most 2,500 homepage rows and 500 about/contact candidates. Capped counts are lower bounds; a bounded sample’s last row is not the domain’s latest-ever capture. Year-range controls share through the URL.
- **About/contact pages are path-name matches**, not verified ownership information. Links always open dated Wayback replays. A limited candidate list may omit pages or return only an early response per path.
- **Availability fallback is approximate:** it returns captures closest to requested dates, not proven first/last captures. Provider errors remain errors, not empty results. Quiet-period inference is suppressed for unavailable, partial or date-restricted sources.
- **.ca history:** CIRA’s current registry record does not expose a complete ownership history. Individual registrants may be privacy protected. Compare source dates without treating re-registration, privacy, or missing archives as proof of wrongdoing. [CIRA’s explanation](https://www.cira.ca/en/resources/news/domains/domain-registration-tips-cira-whois-privacy/) was checked November 25, 2026.
- **Privacy:** the domain/year range goes to CoolCode’s allowlisted archive gateway and Internet Archive; responses are cached up to six hours. Other provider requests remain browser-direct. No browser lookup history is saved. The shareable URL contains the entered domain.

## Expand or customize

Settings live in **`web/config.json`**:

| Key | Meaning |
|---|---|
| `examples` | Quick-pick domains shown under the search box. Any valid domain works; these are just shortcuts. |
| `sources.<name>.enabled` | Turn the registry, certificate or archive lookup on or off. |
| `sources.*.timeout_ms` | Per-source time limits. |
| `sources.certificates.max_rows` | Refuse very large certificate result sets (default 20,000). |
| `sources.archive.proxy` | Allowlisted CoolCode archive gateway; no secret in the frontend. |
| `sources.archive.max_rows` | Documented homepage response cap (2,500); the Worker enforces the real limit. |
| `quiet_years_min` | Minimum run of silent years to mark as a quiet period (default 2). |

For example, to add `gov.nl.ca` as a quick pick, append it to `examples`. Deploy the shared Worker route `/api/domain-biography/archive` before expecting yearly counts; no additional API key is needed. There is no scheduled data refresh: every lookup is live, so a push to `main` (tests, build, deploy) is all that's needed. `tests/model.test.mjs` checks examples beyond the starter list.

## Develop and test

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
python3 scripts/build.py
python3 -m http.server 8000 --directory dist
```

`tests/browser_smoke.py` serves the build at `/domain-biography/` and answers every external request from `tests/fixtures/`. It covers a subdomain lookup, the timeline, quiet periods, registry text containing markup, Markdown export, a shared link, the fallback when CDX and RDAP fail, and the mobile layout.

## Publish

Settings → Pages → Source → **GitHub Actions**. Successful `main` builds deploy to `https://coolcode.ca/domain-biography/`. The catalogue record is in `tool.json`.

Sources: [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json), [crt.sh](https://crt.sh/), [Internet Archive Wayback Machine](https://web.archive.org/).

The saved case files in `web/records/cases.json` are editorial. Review dated official and archive evidence before adding events. A normal build renders the case directory, timelines and result sitemap. Visitor-requested lookups still query their live sources.
