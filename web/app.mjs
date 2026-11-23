import * as M from './model.mjs';

const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') { if (/^https:\/\//.test(v)) el.setAttribute('href', v); }
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
  return el;
}
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}
const day = (iso) => new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmt = new Intl.NumberFormat('en-CA');

let config, current, controller;

async function getJson(url, { timeout, accept = 'application/json' } = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(timeout || 15000), controller.signal]);
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: accept }, signal });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}
const reason = (e) => (e.name === 'TimeoutError' ? 'timed out' : e.name === 'AbortError' ? 'cancelled' : e instanceof TypeError ? 'not reachable from this browser' : e.message);

async function fetchRegistry(domain) {
  const cfg = config.sources.rdap;
  const boot = await getJson(cfg.bootstrap, { timeout: cfg.timeout_ms });
  const base = M.registryFor(domain, boot.services);
  if (!base) return { rdap: null, note: 'IANA lists no RDAP service for this top-level domain.' };
  for (const name of M.registrationCandidates(domain)) {
    try {
      const payload = await getJson(`${base}domain/${encodeURIComponent(name)}`, { timeout: cfg.timeout_ms, accept: 'application/rdap+json, application/json' });
      return { rdap: M.parseRdap(payload), note: name === domain ? `Registry record from ${new URL(base).host}` : `Registry record for the registered name ${name} (${new URL(base).host})`, source: base };
    } catch (e) { if (e.status !== 404) throw e; }
  }
  return { rdap: null, note: 'The registry has no record for this name (it may be unregistered or deleted).' };
}

async function fetchCertificates(domain, subdomains) {
  const cfg = config.sources.certificates;
  const url = new URL(cfg.endpoint);
  url.searchParams.set('q', subdomains ? `%.${domain}` : domain);
  url.searchParams.set('output', 'json');
  const rows = await getJson(url.href, { timeout: cfg.timeout_ms });
  if (rows.length > cfg.max_rows) throw new Error(`more than ${fmt.format(cfg.max_rows)} certificates; try without subdomains`);
  return M.parseCertificates(rows);
}

async function fetchArchive(domain) {
  const cfg = config.sources.archive;
  try {
    const url = new URL(cfg.cdx);
    for (const [k, v] of Object.entries({ url: domain, output: 'json', fl: 'timestamp', collapse: 'timestamp:6', limit: String(cfg.max_months) })) url.searchParams.set(k, v);
    return M.parseCdx(await getJson(url.href, { timeout: cfg.timeout_ms }));
  } catch (e) {
    if (controller.signal.aborted) throw e;
    // CDX is busy or blocked: fall back to two availability lookups for first and latest capture.
    const avail = (ts) => getJson(`${cfg.available}?${new URLSearchParams({ url: domain, timestamp: ts })}`, { timeout: cfg.timeout_ms });
    const [a, b] = await Promise.all([avail('19960101'), avail(new Date().toISOString().slice(0, 10).replaceAll('-', ''))]);
    return M.archiveFromAvailability(a, b);
  }
}

function setStatus(text, error = false) { const el = $('#status'); el.textContent = text; el.classList.toggle('error', error); }

async function lookup(raw) {
  let domain;
  try { domain = M.normalizeDomain(raw); } catch (e) { setStatus(e.message, true); return; }
  controller?.abort();
  controller = new AbortController();
  const subdomains = $('#subdomains').checked;
  $('#domain').value = domain;
  setStatus(`Checking the registry, certificate logs and the Wayback Machine for ${domain}…`);
  try { const u = new URL(location.href); u.searchParams.set('domain', domain); if (subdomains) u.searchParams.set('subdomains', '1'); else u.searchParams.delete('subdomains'); history.replaceState(null, '', u); } catch { /* ignore */ }

  const sources = {};
  const run = async (key, enabled, fn) => {
    if (!enabled) { sources[key] = 'turned off in config.json'; return null; }
    try { return await fn(); } catch (e) { sources[key] = `unavailable (${reason(e)})`; return undefined; }
  };
  const [reg, certs, archive] = await Promise.all([
    run('registry', config.sources.rdap.enabled, () => fetchRegistry(domain)),
    run('certificates', config.sources.certificates.enabled, () => fetchCertificates(domain, subdomains)),
    run('archive', config.sources.archive.enabled, () => fetchArchive(domain)),
  ]);
  if (controller.signal.aborted) return;
  if (reg) sources.registry = reg.note;
  if (certs) sources.certificates = `crt.sh · ${fmt.format(certs.count)} certificates${subdomains ? ' incl. subdomains' : ''}`;
  if (archive) sources.archive = archive.method === 'cdx' ? `Wayback CDX · ${fmt.format(archive.monthsWithCaptures)} months with captures` : 'Wayback availability API (first and latest only; monthly counts were unavailable)';

  const rdap = reg?.rdap || null;
  const timeline = M.buildTimeline({ rdap, certs, archive });
  const activity = M.activityByYear({ rdap, certs, archive }, new Date(), config.quiet_years_min);
  current = { domain, subdomains, retrieved: new Date().toISOString(), rdap, certs: certs || null, archive: archive || null, timeline, activity, sources };
  render(current);
  setStatus(timeline.length ? `Retrieved ${new Date(current.retrieved).toLocaleString('en-CA').replace(/\.$/, '')}.` : `No records found for ${domain}.`, !timeline.length);
}

function render(b) {
  $('#result').hidden = false;
  const reg = b.rdap?.events.find((e) => e.action === 'registration');
  const exp = b.rdap?.events.find((e) => e.action === 'expiration');
  const age = reg ? ((Date.now() - Date.parse(reg.date)) / (365.2425 * 864e5)) : null;
  $('#stats').replaceChildren(...[
    [b.domain, 'domain'],
    [reg ? day(reg.date) : '—', age !== null ? `registered · ${age.toFixed(1)} years ago` : 'registered'],
    [exp ? day(exp.date) : '—', 'registration expires'],
    [b.certs ? fmt.format(b.certs.count) : '—', 'certificates logged'],
    [b.archive?.first ? day(b.archive.first) : '—', 'first archive capture'],
  ].map(([v, l]) => h('div', {}, h('b', {}, v), l)));
  $('#sources').replaceChildren(...Object.entries(b.sources).map(([k, v]) =>
    h('span', { class: `pill ${/unavailable/.test(v) ? 'fail' : /availability API|no record|lists no/.test(v) ? 'partial' : 'ok'}` }, `${k}: ${v}`)));

  $('#timeline').replaceChildren(...(b.timeline.length ? b.timeline.map((t) => h('li', { class: `${t.source}${t.future ? ' future' : ''}` },
    h('span', { class: 'date' }, day(t.date)), ' ', t.label,
    t.detail ? h('span', { class: 'detail' }, ` · ${t.detail}`) : null,
    t.source === 'archive' ? [' ', h('a', { href: M.waybackAt(b.domain, t.date) }, 'view ↗')] : null,
    h('span', { class: 'src' }, t.source))) : [h('li', {}, 'Nothing found in any source.')]));

  renderChart(b.activity);
  $('#quiet').textContent = b.activity.quiet.length
    ? `Quiet periods: ${b.activity.quiet.map((q) => (q.from === q.to ? q.from : `${q.from}–${q.to}`)).join(', ')}. These can mean the domain was parked, lapsed or simply unarchived.`
    : (b.archive?.method === 'available' ? 'Monthly archive counts were unavailable, so quiet periods use certificates and registry events only.' : '');

  const r = b.rdap;
  $('#registry').replaceChildren(...(r ? [
    ['Registrar', r.registrar ? `${r.registrar}${r.registrarIanaId ? ` (IANA ${r.registrarIanaId})` : ''}` : 'not published'],
    ['Status', r.status.join(', ') || 'not published'],
    ['Nameservers', r.nameservers.join(', ') || 'not published'],
    ['DNSSEC', r.dnssec === null ? 'not published' : r.dnssec ? 'signed' : 'not signed'],
  ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]) : [h('dt', {}, 'Registry'), h('dd', {}, b.sources.registry || 'no record')]));

  const iss = b.certs?.issuers || [];
  $('#issuers').replaceChildren(
    h('thead', {}, h('tr', {}, ...['Issuer', 'First', 'Last', 'Count'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, ...(iss.length ? iss.map((i) => h('tr', {}, h('td', {}, i.issuer), h('td', {}, i.first.slice(0, 10)), h('td', {}, i.last.slice(0, 10)), h('td', {}, fmt.format(i.count))))
      : [h('tr', {}, h('td', { colspan: '4' }, b.certs ? 'No certificates logged.' : 'Certificate logs unavailable.'))])));
  const link = $('#issuers').closest('section').querySelector('.crtlink');
  if (link) link.remove();
  $('#issuers').closest('section').append(h('p', { class: 'small crtlink' }, h('a', { href: M.crtLink(b.domain, b.subdomains) }, 'Open on crt.sh ↗'), ' · ', h('a', { href: M.waybackCalendar(b.domain) }, 'Wayback calendar ↗')));
}

function renderChart({ years, quiet }) {
  const el = $('#chart');
  if (!years.length) return el.replaceChildren();
  const W = 900, H = 220, m = { l: 36, r: 8, t: 10, b: 26 };
  const n = years.length, bw = (W - m.l - m.r) / n;
  const max = Math.max(1, ...years.map((y) => Math.max(y.certificates, y.captureMonths)));
  const y = (v) => H - m.b - (Math.sqrt(v) / Math.sqrt(max)) * (H - m.t - m.b); // sqrt scale: busy years don't flatten the rest
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Certificates and archived months per year' });
  for (const q of quiet) {
    const i0 = years.findIndex((v) => v.year === q.from);
    svg.append(s('rect', { class: 'quietband', x: m.l + i0 * bw, y: m.t, width: (q.to - q.from + 1) * bw, height: H - m.t - m.b }));
  }
  for (const v of [0, Math.round(max / 4), max]) svg.append(s('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }), s('text', { x: m.l - 4, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
  years.forEach((v, i) => {
    const x = m.l + i * bw;
    svg.append(
      s('rect', { class: 'certs', x: x + bw * 0.12, y: y(v.certificates), width: bw * 0.36, height: y(0) - y(v.certificates) }, s('title', {}, `${v.year}: ${v.certificates} certificates`)),
      s('rect', { class: 'caps', x: x + bw * 0.52, y: y(v.captureMonths), width: bw * 0.36, height: y(0) - y(v.captureMonths) }, s('title', {}, `${v.year}: ${v.captureMonths} months with captures`)));
    if (n <= 16 || i % Math.ceil(n / 16) === 0) svg.append(s('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, String(v.year)));
  });
  el.replaceChildren(svg);
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', {}); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#lookup').addEventListener('submit', (e) => { e.preventDefault(); lookup($('#domain').value); });
$('#dl-md').addEventListener('click', () => current && download(`${current.domain}-biography.md`, 'text/markdown', M.toMarkdown(current.domain, current)));
$('#dl-json').addEventListener('click', () => current && download(`${current.domain}-biography.json`, 'application/json', JSON.stringify(current, null, 2)));
$('#copy-link').addEventListener('click', async (ev) => {
  try { await navigator.clipboard.writeText(location.href); ev.target.textContent = 'Link copied'; } catch { ev.target.textContent = 'Copy unavailable: use the address bar'; }
  setTimeout(() => { ev.target.textContent = 'Copy link to this lookup'; }, 2500);
});

try {
  config = await (await fetch('./config.json')).json();
  $('#examples').replaceChildren('Try: ', ...config.examples.map((d) => h('button', { type: 'button', class: 'quiet-btn', onclick: () => lookup(d) }, d)));
  const params = new URL(location.href).searchParams;
  if (params.get('subdomains') === '1') $('#subdomains').checked = true;
  if (params.get('domain')) lookup(params.get('domain'));
} catch (e) {
  setStatus('Configuration failed to load.', true);
  console.error(e);
}
