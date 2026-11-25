// Pure logic for Domain Biography: parsing RDAP, crt.sh and Wayback CDX responses
// and assembling one dated timeline. No DOM, no network — unit-tested directly.

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Normalise visitor input to an ASCII (punycode) hostname, or throw a readable error. */
export function normalizeDomain(input) {
  if (typeof input !== 'string') throw new TypeError('Expected text');
  let text = input.trim().toLowerCase();
  if (!text) throw new Error('Enter a domain name, such as cira.ca.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `http://${text}`;
  let host;
  try { host = new URL(text).hostname; } catch { throw new Error('That doesn’t look like a domain name.'); }
  host = host.replace(/\.$/, '');
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':') || host.startsWith('[')) throw new Error('Enter a domain name, not an IP address.');
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) throw new Error('That doesn’t look like a domain name.');
  if (host.length > 253) throw new Error('That name is too long.');
  return host;
}

/** Names to try at the registry: the name itself, then each parent down to two labels. */
export function registrationCandidates(domain) {
  const labels = domain.split('.');
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** Longest-suffix match in IANA's RDAP bootstrap (RFC 9224). Returns an https base URL or ''. */
export function registryFor(domain, services) {
  let best = { length: -1, base: '' };
  for (const entry of Array.isArray(services) ? services : []) {
    const base = Array.isArray(entry?.[1]) ? entry[1].find((u) => typeof u === 'string' && u.startsWith('https://')) : null;
    if (!base || !Array.isArray(entry[0])) continue;
    for (const tld of entry[0]) {
      const t = String(tld).toLowerCase();
      if ((domain === t || domain.endsWith(`.${t}`)) && t.length > best.length) best = { length: t.length, base };
    }
  }
  return best.base ? best.base.replace(/\/?$/, '/') : '';
}

const vcardName = (entity) => {
  const card = entity?.vcardArray?.[1];
  if (!Array.isArray(card)) return null;
  const fn = card.find((p) => p[0] === 'fn') || card.find((p) => p[0] === 'org');
  return fn ? String(fn[3]).trim() || null : null;
};
const iso = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

/** Reduce an RDAP domain object to the fields the biography uses. */
export function parseRdap(payload) {
  if (!payload || payload.objectClassName !== 'domain') throw new Error('The registry returned something other than a domain record.');
  const registrar = (payload.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const ianaId = registrar?.publicIds?.find((p) => /iana/i.test(p.type))?.identifier || null;
  const events = (payload.events || [])
    .map((e) => ({ action: String(e.eventAction || '').toLowerCase(), date: iso(e.eventDate) }))
    .filter((e) => e.action && e.date);
  return {
    name: String(payload.ldhName || payload.unicodeName || '').toLowerCase(),
    registrar: registrar ? (vcardName(registrar) || registrar.handle || 'Unnamed registrar') : null,
    registrarIanaId: ianaId,
    status: (payload.status || []).map(String),
    nameservers: (payload.nameservers || []).map((n) => String(n.ldhName || '').toLowerCase()).filter(Boolean).sort(),
    dnssec: payload.secureDNS ? Boolean(payload.secureDNS.delegationSigned) : null,
    events: events.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Summarise crt.sh JSON rows: counts per year, issuers with first/last dates. */
export function parseCertificates(rows) {
  if (!Array.isArray(rows)) throw new Error('Expected a crt.sh JSON array.');
  const seen = new Set();
  const byYear = {};
  const issuers = new Map();
  let first = null, latest = null;
  for (const r of rows) {
    const id = r.id ?? r.min_cert_id ?? `${r.serial_number}|${r.issuer_name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const when = iso(r.not_before || r.entry_timestamp);
    if (!when) continue;
    const year = when.slice(0, 4);
    byYear[year] = (byYear[year] || 0) + 1;
    const issuer = issuerName(r.issuer_name);
    const it = issuers.get(issuer) || { issuer, first: when, last: when, count: 0 };
    it.count++;
    if (when < it.first) it.first = when;
    if (when > it.last) it.last = when;
    issuers.set(issuer, it);
    if (!first || when < first.date) first = { date: when, issuer, id: r.id ?? null };
    if (!latest || when > latest.date) latest = { date: when, issuer, id: r.id ?? null, expires: iso(r.not_after) };
  }
  return { count: seen.size, first, latest, byYear, issuers: [...issuers.values()].sort((a, b) => a.first.localeCompare(b.first)) };
}

/** "C=US, O=Let's Encrypt, CN=R3" → "Let's Encrypt" (organisation, else common name). */
export function issuerName(dn = '') {
  const part = (k) => String(dn).match(new RegExp(`(?:^|,\\s*)${k}=("([^"]*)"|[^,]*)`))?.[2] ?? String(dn).match(new RegExp(`(?:^|,\\s*)${k}=([^,]*)`))?.[1];
  return (part('O') || part('CN') || String(dn) || 'Unknown issuer').trim();
}

export const tsToIso = (ts) => {
  const v=String(ts);if(!/^\d{14}$/.test(v))return null;
  const when=new Date(Date.UTC(+v.slice(0,4),+v.slice(4,6)-1,+v.slice(6,8),+v.slice(8,10),+v.slice(10,12),+v.slice(12,14)));
  if(!Number.isFinite(+when)||when.toISOString().replace(/\D/g,'').slice(0,14)!==v)return null;
  return when.toISOString();
};

/** Counts actual indexed responses in a bounded exact-homepage query, never monthly samples. */
export function parseCdx(payload) {
  const envelope=payload?.data||payload;
  const rows=Array.isArray(envelope)?envelope:envelope?.rows;
  if(!Array.isArray(rows))throw Error('Expected Wayback CDX JSON.');
  const header=rows[0]||[],hasHeader=Array.isArray(header)&&header.includes('timestamp');
  if(rows.length&&!hasHeader)throw Error('Unexpected Wayback CDX header.');
  const body=hasHeader?rows.slice(1):rows;
  const index=k=>hasHeader?header.indexOf(k):-1;
  const byYear={},months=new Set(),seen=new Set();let first=null,latest=null,firstUrl=null,latestUrl=null,count=0;
  for(const row of body){
    if(!Array.isArray(row))continue;
    const stamp=row[hasHeader?index('timestamp'):0],when=tsToIso(stamp);if(!when)continue;
    if(index('statuscode')>=0&&String(row[index('statuscode')])!=='200')continue;
    if(index('mimetype')>=0&&!['text/html','application/xhtml+xml'].includes(row[index('mimetype')]))continue;
    const original=index('original')>=0?row[index('original')]:null;
    if(original&&!/^https?:\/\//i.test(original))continue;
    const key=stamp+'|'+(original||'');if(seen.has(key))continue;seen.add(key);
    const link=original?'https://web.archive.org/web/'+stamp+'/'+original:null;
    count++;months.add(when.slice(0,7));byYear[when.slice(0,4)]=(byYear[when.slice(0,4)]||0)+1;
    if(!first||when<first){first=when;firstUrl=link;}
    if(!latest||when>latest){latest=when;latestUrl=link;}
  }
  return {first,latest,firstUrl,latestUrl,count,monthsWithCaptures:months.size,byYear,method:'cdx',truncated:!!envelope.truncated,checkedAt:envelope.checked_at||null,scope:'Exact homepage; successful HTML responses'};
}
export function parseArchivePages(payload,domain){
 const envelope=payload?.data||payload,rows=envelope?.rows||[];
 if(!Array.isArray(rows)||!Array.isArray(rows[0]))throw Error('Invalid archived page response');
 const h=rows[0],ix=k=>h.indexOf(k);if(ix('timestamp')<0||ix('original')<0)throw Error('Invalid archived page schema');
 const pages=new Map();
 for(const row of rows.slice(1)){
  const date=tsToIso(row[ix('timestamp')]);if(!date)continue;
  let u;try{u=new URL(row[ix('original')]);}catch{continue;}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hostname.replace(/^www\./,'')!==domain.replace(/^www\./,''))continue;
  if(!/(?:^|\/)(?:about(?:[-_]us)?|contact(?:[-_]us)?|a-propos|nous-joindre)(?:[.\/]|$)/i.test(u.pathname))continue;
  if(ix('statuscode')>=0&&String(row[ix('statuscode')])!=='200')continue;
  const key=u.hostname+u.pathname;const prev=pages.get(key);
  if(!prev||date<prev.date)pages.set(key,{original:u.href,path:u.pathname,date,url:'https://web.archive.org/web/'+row[ix('timestamp')]+'/'+u.href});
 }
 return {items:[...pages.values()].sort((a,b)=>a.date.localeCompare(b.date)),truncated:!!envelope.truncated};
}
export function archiveRange(from,to){
 const valid=s=>!s||/^\d{4}$/.test(s)&&+s>=1990&&+s<=new Date().getUTCFullYear();
 if(!valid(from)||!valid(to)||from&&to&&from>to)throw Error('Use archive years from 1990 through the current year, with the start no later than the end.');
 return {from:from||'',to:to||''};
}
const safeReplay=url=>{try{const u=new URL(url);if(u.hostname==='web.archive.org'&&!u.username&&!u.password&&/^\/web\/\d{14}\//.test(u.pathname))return u.href.replace(/^http:/,'https:');}catch{}return null;};

/** Fallback when CDX is unavailable: two availability-API answers (closest to 1996 and to now). */
export function archiveFromAvailability(earliest, newest) {
  const pick = (r) => r?.archived_snapshots?.closest;
  const a = pick(earliest), b = pick(newest);
  const first = a?.available && String(a.status)==='200' ? tsToIso(a.timestamp) : null;
  const latest = b?.available && String(b.status)==='200' ? tsToIso(b.timestamp) : first;
  return { first, latest, monthsWithCaptures: null, byYear: {}, method: 'available', truncated: true, count: null, firstUrl: safeReplay(a?.url), latestUrl: safeReplay(b?.url) };
}

export const waybackCalendar = (domain) => `https://web.archive.org/web/*/${domain}`;
export const waybackAt = (domain, isoDate) => `https://web.archive.org/web/${isoDate.replace(/\D/g, '').slice(0, 14)}/${domain}`;
export const crtLink = (domain, sub) => `https://crt.sh/?q=${encodeURIComponent(sub ? `%.${domain}` : domain)}`;

const RDAP_LABELS = {
  registration: 'Registered',
  reregistration: 'Re-registered',
  transfer: 'Transferred',
  'last changed': 'Registry record changed',
  expiration: 'Registration expires',
  'last update of rdap database': null, // registry housekeeping, not part of the domain's story
  deletion: 'Deleted',
  reinstantiation: 'Reinstated',
  locked: 'Locked',
  unlocked: 'Unlocked',
};

/** Merge the sources into one chronological list of {date, source, label, detail}. */
export function buildTimeline({ rdap, certs, archive }, now = new Date()) {
  const items = [];
  for (const e of rdap?.events || []) {
    const label = e.action in RDAP_LABELS ? RDAP_LABELS[e.action] : e.action.replace(/^\w/, (c) => c.toUpperCase());
    if (label) items.push({ date: e.date, source: 'registry', label, future: Date.parse(e.date) > +now });
  }
  if (certs?.first) items.push({ date: certs.first.date, source: 'certificates', label: 'First logged TLS certificate', detail: certs.first.issuer });
  for (const i of certs?.issuers || []) {
    if (certs.issuers.length > 1 && i.first !== certs.first?.date) items.push({ date: i.first, source: 'certificates', label: 'New certificate issuer', detail: i.issuer });
  }
  if (certs?.latest && certs.latest.date !== certs.first?.date) items.push({ date: certs.latest.date, source: 'certificates', label: 'Most recent certificate', detail: certs.latest.issuer });
  if (archive?.first) items.push({ date: archive.first, source: 'archive', label: archive.method==='available'?'Earlier closest available Wayback capture':'Earliest observed homepage capture', url:archive.firstUrl });
  if (archive?.latest && archive.latest !== archive.first) items.push({ date: archive.latest, source: 'archive', label: archive.method==='available'?'Recent closest available Wayback capture':archive.truncated?'Latest in bounded homepage sample':'Latest observed homepage capture', url:archive.latestUrl });
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));
}

/** Year-by-year activity from first evidence to `now`, with runs of silent years marked as quiet periods. */
export function activityByYear({ certs, archive, rdap }, now = new Date(), quietMin = 2) {
  const dates = [
    ...(rdap?.events || []).filter((e) => Date.parse(e.date) <= +now).map((e) => e.date),
    certs?.first?.date, archive?.first,
  ].filter(Boolean).sort();
  if (!dates.length) return { years: [], quiet: [] };
  const start = +dates[0].slice(0, 4), end = now.getUTCFullYear();
  const regYears = new Set((rdap?.events || []).filter((e) => Date.parse(e.date) <= +now).map((e) => e.date.slice(0, 4)));
  const archiveYears = new Set([archive?.first, archive?.latest].filter(Boolean).map((d) => d.slice(0, 4)));
  const years = [];
  for (let y = start; y <= end; y++) {
    const k = String(y);
    years.push({ year: y, certificates: certs?.byYear?.[k] || 0, captures: archive?.method==='cdx'?(archive.byYear?.[k]||0):null, registry: regYears.has(k) });
  }
  const quiet = [];
  let run = null;
  for (const y of years) {
    const silent = !!certs && !!rdap && archive?.method==='cdx' && !archive.truncated && !archive.range?.from && !archive.range?.to && y.certificates === 0 && y.captures === 0 && !y.registry && y.year < end;
    if (silent) run = run ? { ...run, to: y.year } : { from: y.year, to: y.year };
    else { if (run && run.to - run.from + 1 >= quietMin) quiet.push(run); run = null; }
  }
  if (run && run.to - run.from + 1 >= quietMin) quiet.push(run);
  return { years, quiet };
}

/** Plain-text/Markdown report for export. */
export function toMarkdown(domain, bio, generated = new Date()) {
  const lines = [`# Domain Biography: ${domain}`, '', `Generated ${generated.toISOString()} by https://coolcode.ca/domain-biography/`, ''];
  if (bio.rdap) {
    lines.push('## Registry', `- Registrar: ${bio.rdap.registrar || 'not stated'}`, `- Status: ${bio.rdap.status.join(', ') || 'not stated'}`,
      `- Nameservers: ${bio.rdap.nameservers.join(', ') || 'not stated'}`, `- DNSSEC: ${bio.rdap.dnssec === null ? 'not stated' : bio.rdap.dnssec ? 'signed' : 'unsigned'}`, '');
  }
  lines.push('## Timeline');
  for (const t of bio.timeline) lines.push(`- ${t.date.slice(0, 10)} — ${t.label}${t.detail ? ` (${t.detail})` : ''} [${t.source}]`);
  if(bio.archive?.count!==null&&bio.archive?.count!==undefined){lines.push('', '## Archived homepage observations', bio.archive.truncated?'Bounded sample: counts are lower bounds, not full site totals.':'Successful HTML responses at the exact homepage only.', '| Year | Observed captures |','|---|---:|',...Object.entries(bio.archive.byYear).sort().map(([y,n])=>`| ${y} | ${n} |`));}
  if(bio.archive?.pages?.items?.length)lines.push('', '## Archived about/contact pages',...bio.archive.pages.items.map(p=>`- ${p.date.slice(0,10)} [${p.path}](${p.url})`));
  if (bio.activity?.quiet?.length) lines.push('', '## Quiet periods', ...bio.activity.quiet.map((q) => `- ${q.from}${q.to !== q.from ? `–${q.to}` : ''}: no certificates, captures or registry events found`));
  lines.push('', '## Sources', ...Object.entries(bio.sources || {}).map(([k, v]) => `- ${k}: ${v}`));
  return lines.join('\n') + '\n';
}
