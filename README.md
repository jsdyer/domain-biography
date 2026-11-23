# Domain Biography

Follow a domain's life on one timeline, at **https://coolcode.ca/domain-biography/**: when it was registered, transferred and changed at the registry, when certificates were first and last issued (and by whom), when the Wayback Machine first and last captured it, and the quiet years in between.

| Source | What it adds | How |
|---|---|---|
| IANA RDAP bootstrap, then the registry's RDAP service (CIRA for .ca) | Registration, transfer, last-changed and expiry events; registrar; status; nameservers; DNSSEC | Live, from your browser |
| crt.sh certificate transparency search | First and latest logged certificates, certificates per year, each issuer's first and last use | Live, from your browser |
| Internet Archive Wayback CDX (falls back to the availability API) | First and latest captures and months with captures per year | Live, from your browser |

## Reading the results

<!-- coolcode:guide -->
Enter a domain such as cira.ca, or paste a full URL. A subdomain is looked up under its registered name at the registry. The timeline marks each event with its source. A quiet period means two or more years in which no source recorded anything, which often points to a parked, lapsed or re-registered domain. Compare that span with the registration date: a "Registered" date after the first archive capture usually means the name expired and someone registered it again. Use "Copy link" to share a lookup, or download the report as Markdown or JSON.
<!-- /coolcode:guide -->

- **RDAP shows the registry's current record.** Earlier registrars and owners appear only if an event (such as a transfer) records them, and registries publish different event types. "Registry record changed" can mean any update, such as nameservers, status or contacts.
- **Certificate logs** begin around 2013, and many older sites never used TLS. By default only certificates naming the domain itself are counted. Tick **Include subdomain certificates** to add `%.domain`; large sites can return tens of thousands of rows and may time out.
- **Archive counts are months with at least one capture**, not total captures. If the CDX service is busy, only the first and latest captures are shown, and the source chip says so.

## Expand or customize

Settings live in **`web/config.json`**:

| Key | Meaning |
|---|---|
| `examples` | Quick-pick domains shown under the search box. Any valid domain works; these are just shortcuts. |
| `sources.<name>.enabled` | Turn the registry, certificate or archive lookup on or off. |
| `sources.*.timeout_ms` | Per-source time limits. |
| `sources.certificates.max_rows` | Refuse very large certificate result sets (default 20,000). |
| `sources.archive.max_months` | Upper bound on CDX rows (one per month). |
| `quiet_years_min` | Minimum run of silent years to mark as a quiet period (default 2). |

For example, to add `gov.nl.ca` as a quick pick, append it to `examples`. There is no data refresh: every lookup is live, so a push to `main` (tests, build, deploy) is all that's needed. `tests/model.test.mjs` checks examples beyond the starter list.

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
