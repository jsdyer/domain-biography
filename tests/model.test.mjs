import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../web/model.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const NOW = new Date('2026-11-23T12:00:00Z');

test('normalizes input to an ASCII hostname and rejects addresses', () => {
  assert.equal(M.normalizeDomain('  HTTPS://Www.CIRA.ca/en/path?q=1 '), 'www.cira.ca');
  assert.equal(M.normalizeDomain('cira.ca.'), 'cira.ca');
  assert.equal(M.normalizeDomain('bücher.example'), 'xn--bcher-kva.example');
  for (const bad of ['', '192.0.2.1', '[2001:db8::1]', 'localhost', 'bad_label.ca', '-x.ca']) assert.throws(() => M.normalizeDomain(bad), Error, bad);
});

test('registration candidates walk up to the registered name', () => {
  assert.deepEqual(M.registrationCandidates('a.b.example.co.uk'), ['a.b.example.co.uk', 'b.example.co.uk', 'example.co.uk', 'co.uk']);
});

test('IANA bootstrap: longest suffix, https only', () => {
  const services = fx('iana-dns.json').services;
  assert.equal(M.registryFor('www.cira.ca', services), 'https://rdap.ca.fury.ca/rdap/');
  assert.equal(M.registryFor('example.org', services), 'https://rdap.publicinterestregistry.org/rdap/');
  assert.equal(M.registryFor('example.zz', services), '');
  assert.equal(M.registryFor('notca', services), '');
});

test('RDAP record parses registrar, status, sorted nameservers, DNSSEC and events', () => {
  const r = M.parseRdap(fx('rdap-ca.json'));
  assert.equal(r.registrar, '<b>Maple</b> Registrar Inc.');
  assert.equal(r.registrarIanaId, '9999');
  assert.deepEqual(r.nameservers, ['ns1.example.net', 'ns2.example.net']);
  assert.equal(r.dnssec, true);
  assert.deepEqual(r.events.map((e) => e.action), ['registration', 'transfer', 'last changed', 'last update of rdap database', 'expiration']);
  assert.throws(() => M.parseRdap({ objectClassName: 'entity' }), /domain record/);
});

test('certificates: de-duplicated, counted per year, issuers with first/last', () => {
  const c = M.parseCertificates(fx('crt.json'));
  assert.equal(c.count, 2 + 1 + 8 * 4);
  assert.equal(c.first.date.slice(0, 10), '2014-05-01');
  assert.equal(c.first.issuer, 'GeoTrust Inc.');
  assert.equal(c.byYear['2019'], 4);
  assert.equal(c.byYear['2016'], undefined);
  assert.deepEqual(c.issuers.map((i) => i.issuer), ['GeoTrust Inc.', "Let's Encrypt"]);
  assert.equal(M.issuerName('CN=Only Common Name'), 'Only Common Name');
  assert.throws(() => M.parseCertificates({}), /crt.sh/);
});

test('Wayback CDX months and the availability fallback', () => {
  const a = M.parseCdx(fx('cdx.json'));
  assert.equal(a.first.slice(0, 10), '2002-01-15');
  assert.equal(a.latest.slice(0, 7), '2026-06');
  assert.equal(a.monthsWithCaptures, 28);
  assert.equal(a.byYear['2012'], 2);
  const b = M.archiveFromAvailability(fx('avail-first.json'), fx('avail-latest.json'));
  assert.equal(b.method, 'available');
  assert.equal(b.first.slice(0, 10), '2002-01-15');
  assert.equal(b.latest.slice(0, 10), '2026-11-01');
  assert.equal(M.archiveFromAvailability({}, {}).first, null);
});

test('timeline merges sources, hides registry housekeeping and flags future expiry', () => {
  const rdap = M.parseRdap(fx('rdap-ca.json'));
  const certs = M.parseCertificates(fx('crt.json'));
  const archive = M.parseCdx(fx('cdx.json'));
  const t = M.buildTimeline({ rdap, certs, archive }, NOW);
  assert.deepEqual(t.map((x) => x.label), [
    'First Wayback Machine capture', 'Registered', 'First logged TLS certificate', 'Transferred',
    'New certificate issuer', 'Registry record changed', 'Most recent certificate', 'Latest Wayback Machine capture', 'Registration expires',
  ]);
  assert.equal(t.at(-1).future, true);
  assert.ok(!t.some((x) => /rdap database/i.test(x.label)));
  assert.deepEqual(M.buildTimeline({}), []);
});

test('quiet periods need two silent years and respect missing archive counts', () => {
  const rdap = M.parseRdap(fx('rdap-ca.json'));
  const certs = M.parseCertificates(fx('crt.json'));
  const archive = M.parseCdx(fx('cdx.json'));
  const a = M.activityByYear({ rdap, certs, archive }, NOW, 2);
  assert.equal(a.years[0].year, 2002);
  assert.equal(a.years.at(-1).year, 2026);
  assert.deepEqual(a.quiet, [{ from: 2006, to: 2011 }, { from: 2016, to: 2018 }]);
  const fallback = M.archiveFromAvailability(fx('avail-first.json'), fx('avail-latest.json'));
  const b = M.activityByYear({ rdap, certs, archive: fallback }, NOW, 2);
  assert.deepEqual(b.quiet, [{ from: 2005, to: 2013 }, { from: 2016, to: 2018 }]);
});

test('markdown export lists registry, timeline and quiet periods', () => {
  const rdap = M.parseRdap(fx('rdap-ca.json'));
  const certs = M.parseCertificates(fx('crt.json'));
  const archive = M.parseCdx(fx('cdx.json'));
  const md = M.toMarkdown('example-history.ca', { rdap, timeline: M.buildTimeline({ rdap, certs, archive }, NOW), activity: M.activityByYear({ rdap, certs, archive }, NOW), sources: { registry: 'test' } }, NOW);
  assert.match(md, /^# Domain Biography: example-history.ca/);
  assert.match(md, /DNSSEC: signed/);
  assert.match(md, /2015-06-01 — Transferred \[registry\]/);
  assert.match(md, /2006–2011: no certificates/);
});

test('configured examples are valid domains, and any extra example works the same way', () => {
  const config = JSON.parse(readFileSync(new URL('../web/config.json', import.meta.url), 'utf8'));
  for (const d of [...config.examples, 'gov.nl.ca', 'xn--bcher-kva.example']) assert.equal(M.normalizeDomain(d), d);
  assert.ok(config.sources.certificates.max_rows > 0 && config.quiet_years_min >= 1);
});
