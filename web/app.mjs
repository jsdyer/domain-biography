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

let config, current, controller, lookupVersion=0;

async function getJson(url, { timeout, accept = 'application/json', requestSignal=controller.signal } = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(timeout || 15000), requestSignal]);
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: accept }, signal });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}
const reason = (e) => (e.name === 'TimeoutError' ? 'timed out' : e.name === 'AbortError' ? 'cancelled' : e instanceof TypeError ? 'not reachable from this browser' : e.message);

async function fetchRegistry(domain,requestSignal) {
  const cfg = config.sources.rdap;
  const boot = await getJson(cfg.bootstrap, { requestSignal, timeout: cfg.timeout_ms });
  const base = M.registryFor(domain, boot.services);
  if (!base) return { rdap: null, note: 'IANA lists no RDAP service for this top-level domain.' };
  for (const name of M.registrationCandidates(domain)) {
    try {
      const payload = await getJson(`${base}domain/${encodeURIComponent(name)}`, { requestSignal, timeout: cfg.timeout_ms, accept: 'application/rdap+json, application/json' });
      return { rdap: M.parseRdap(payload), note: name === domain ? `Registry record from ${new URL(base).host}` : `Registry record for the registered name ${name} (${new URL(base).host})`, source: base };
    } catch (e) { if (e.status !== 404) throw e; }
  }
  return { rdap: null, note: 'The registry has no record for this name (it may be unregistered or deleted).' };
}

async function fetchCertificates(domain, subdomains,requestSignal) {
  const cfg = config.sources.certificates;
  const url = new URL(cfg.endpoint);
  url.searchParams.set('q', subdomains ? `%.${domain}` : domain);
  url.searchParams.set('output', 'json');
  const rows = await getJson(url.href, { requestSignal, timeout: cfg.timeout_ms });
  if (rows.length > cfg.max_rows) throw new Error(`more than ${fmt.format(cfg.max_rows)} certificates; try without subdomains`);
  return M.parseCertificates(rows);
}

async function fetchArchive(domain,requestSignal,range) {
 const cfg=config.sources.archive;
 const proxy=mode=>getJson(cfg.proxy+'?'+new URLSearchParams({domain,mode,...Object.fromEntries(Object.entries(range).filter(([,v])=>v))}),{requestSignal,timeout:cfg.timeout_ms});
 let archive;
 try{archive=M.parseCdx(await proxy('homepage'));}
 catch(error){
  if(requestSignal.aborted)throw error;
  const avail=ts=>getJson(cfg.available+'?'+new URLSearchParams({url:domain,timestamp:ts}),{requestSignal,timeout:cfg.timeout_ms});
  const [a,b]=await Promise.all([avail(range.from?range.from+'0101':'19960101'),avail(range.to?range.to+'1231':new Date().toISOString().slice(0,10).replaceAll('-',''))]);
  if(a.error||b.error)throw Error('The Internet Archive is temporarily unavailable.');
  archive=M.archiveFromAvailability(a,b);
 }
 archive.range=range;
 try{archive.pages=M.parseArchivePages(await proxy('pages'),domain);}catch(error){if(requestSignal.aborted)throw error;archive.pages={items:[],unavailable:true};}
 return archive;
}

function setStatus(text, error = false) { const el = $('#status'); el.textContent = text; el.classList.toggle('error', error); }

async function lookup(raw) {
  let domain,range;
  try { domain = M.normalizeDomain(raw);range=M.archiveRange($('#from-year').value,$('#to-year').value); } catch (e) { setStatus(e.message, true); return; }
  controller?.abort();
  controller = new AbortController();
  const version=++lookupVersion,requestSignal=controller.signal;
  current=null;$('#result').hidden=true;
  const subdomains = $('#subdomains').checked;
  $('#domain').value = domain;
  setStatus(`Checking the registry, certificate logs and the Wayback Machine for ${domain}…`);
  try { const u = new URL(location.href); u.searchParams.set('domain', domain); if (subdomains) u.searchParams.set('subdomains', '1'); else u.searchParams.delete('subdomains'); for(const [key,value]of Object.entries(range)){if(value)u.searchParams.set(key,value);else u.searchParams.delete(key);}history.replaceState(null, '', u); } catch { /* ignore */ }

  const sources = {};
  const run = async (key, enabled, fn) => {
    if (!enabled) { sources[key] = 'turned off in config.json'; return null; }
    try { return await fn(); } catch (e) { sources[key] = `unavailable (${reason(e)})`; return undefined; }
  };
  const [reg, certs, archive] = await Promise.all([
    run('registry', config.sources.rdap.enabled, () => fetchRegistry(domain,requestSignal)),
    run('certificates', config.sources.certificates.enabled, () => fetchCertificates(domain, subdomains,requestSignal)),
    run('archive', config.sources.archive.enabled, () => fetchArchive(domain,requestSignal,range)),
  ]);
  if (requestSignal.aborted||version!==lookupVersion) return;
  if (reg) sources.registry = reg.note;
  if (certs) sources.certificates = `crt.sh · ${fmt.format(certs.count)} certificates${subdomains ? ' incl. subdomains' : ''}`;
  if (archive) sources.archive = archive.method === 'cdx' ? `Wayback CDX · ${fmt.format(archive.count)} observed homepage captures${archive.truncated?' · bounded sample / lower bounds':''}` : 'Wayback availability API · closest available captures only; yearly counts unavailable';

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
    [b.archive?.first ? day(b.archive.first) : '—', 'earliest observed archive capture'],
  ].map(([v, l]) => h('div', {}, h('b', {}, v), l)));
  $('#sources').replaceChildren(...Object.entries(b.sources).map(([k, v]) =>
    h('span', { class: `pill ${/unavailable/.test(v) ? 'fail' : /availability API|no record|lists no/.test(v) ? 'partial' : 'ok'}` }, `${k}: ${v}`)));

  $('#timeline').replaceChildren(...(b.timeline.length ? b.timeline.map((t) => h('li', { class: `${t.source}${t.future ? ' future' : ''}` },
    h('span', { class: 'date' }, day(t.date)), ' ', t.label,
    t.detail ? h('span', { class: 'detail' }, ` · ${t.detail}`) : null,
    t.source === 'archive' ? [' ', h('a', { href: t.url?.replace(/^http:/,'https:')||M.waybackAt(b.domain, t.date) }, 'view capture')] : null,
    h('span', { class: 'src' }, t.source))) : [h('li', {}, 'Nothing found in any source.')]));

  renderChart(b.activity);renderArchive(b);
  $('#quiet').textContent = b.activity.quiet.length
    ? `Quiet periods: ${b.activity.quiet.map((q) => (q.from === q.to ? q.from : `${q.from}–${q.to}`)).join(', ')}. These are gaps in the queried records, not evidence that the domain stopped operating.`
    : (!b.archive||b.archive.method==='available'||b.archive.truncated||b.archive.range?.from||b.archive.range?.to||!b.certs||!b.rdap?'No quiet-period inference is made because at least one source is incomplete or date-limited.':'');

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
  const max = Math.max(1, ...years.map((y) => Math.max(y.certificates, y.captures)));
  const y = (v) => H - m.b - (Math.sqrt(v) / Math.sqrt(max)) * (H - m.t - m.b); // sqrt scale: busy years don't flatten the rest
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Certificates and observed homepage captures per year' });
  for (const q of quiet) {
    const i0 = years.findIndex((v) => v.year === q.from);
    svg.append(s('rect', { class: 'quietband', x: m.l + i0 * bw, y: m.t, width: (q.to - q.from + 1) * bw, height: H - m.t - m.b }));
  }
  for (const v of [0, Math.round(max / 4), max]) svg.append(s('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }), s('text', { x: m.l - 4, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
  years.forEach((v, i) => {
    const x = m.l + i * bw;
    svg.append(
      s('rect', { class: 'certs', x: x + bw * 0.12, y: y(v.certificates), width: bw * 0.36, height: y(0) - y(v.certificates) }, s('title', {}, `${v.year}: ${v.certificates} certificates`)),
      s('rect', { class: 'caps', x: x + bw * 0.52, y: y(v.captures), width: bw * 0.36, height: y(0) - y(v.captures) }, s('title', {}, `${v.year}: ${v.captures===null?'archive count unknown':v.captures+' observed homepage captures'}`)));
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
  for(const key of ['from','to'])$(`#${key}-year`).value=params.get(key)||'';
  if (params.get('subdomains') === '1') $('#subdomains').checked = true;
  if (params.get('domain')) lookup(params.get('domain'));
} catch (e) {
  setStatus('Configuration failed to load.', true);
  console.error(e);
}

function renderArchive(b){
 const a=b.archive;
 $('#archive-note').textContent=!a?'Archive unavailable. Use the Wayback calendar to investigate separately.':a.method==='available'?'Only closest available captures were returned. These are not guaranteed first/last captures, and yearly counts are unknown.':(a.truncated?'The response reached the row limit. Counts below are lower bounds; narrow the year range and run again. ':'')+'Scope: successful HTML responses at the exact homepage, not every page or subdomain. '+(a.range?.from||a.range?.to?'Selected years: '+(a.range.from||'earliest')+' to '+(a.range.to||'latest')+'. ':'')+'Capture date is an observation, not the site’s launch or domain registration date.';
 const rows=Object.entries(a?.byYear||{}).sort();
 $('#archive-years').replaceChildren(h('thead',{},h('tr',{},h('th',{scope:'col'},'Year'),h('th',{scope:'col'},'Observed captures'),h('th',{scope:'col'},'Inspect'))),h('tbody',{},...rows.map(([year,count])=>h('tr',{},h('td',{},year),h('td',{},(a.truncated?'≥ ':'')+fmt.format(count)),h('td',{},h('a',{href:'https://web.archive.org/web/'+year+'*/'+b.domain},'Year calendar'))))));
 $('#archive-pages').replaceChildren(...(a?.pages?.items?.length?a.pages.items.map(p=>h('li',{},h('a',{href:p.url},p.path),' · observed '+day(p.date))):[h('li',{},a?.pages?.unavailable?'Archived-page discovery is unavailable right now.':'No matching about/contact paths appeared in this bounded index query.') ]));
 $('#pages-note').textContent='Matching path names identify candidates, not verified ownership or contact details. Open the dated capture to read its contents.'+(a?.pages?.truncated?' This page list reached its limit and is incomplete.':'');
 $('#ca-history').hidden=!b.domain.endsWith('.ca');
 $('#ca-detail').textContent=b.domain.endsWith('.ca')?'For .ca names, CIRA’s current registry record is separate from the web archive. A later registration date than an archived page can reflect re-registration or registry-record history; it does not establish ownership continuity. Individual registrants may be privacy protected.':'';
 $('#investigation').replaceChildren(...[['scanreceipt','Inspect the current site'],['scamtrace','Check reported warning signals'],['corporateghosts','Check a company’s registration']].map(([id,label])=>h('li',{},h('a',{href:'https://coolcode.ca/'+id+'/'},label),' · '+id)));
 $('#investigation-domain').textContent='Continue with '+b.domain+'. These tools answer different questions; old archives or a registry entry alone do not establish that a site is trustworthy.';
}
