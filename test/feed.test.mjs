import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseInput, podcastInput, episodeInput } from '../dist/input.js';
import { createFeed, addEpisode, uuidV5 } from '../dist/feed.js';
import { validate } from '../dist/validate.js';
import { parseXml, select, channelOf, serialize, append } from '../dist/xml.js';
import { NS, isoDate, rssDate } from '../dist/core.js';
import { podcastRules } from '../dist/podcast.js';

const read = async name => parseInput(await readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8'));
const podcast = podcastInput(await read('podcast.yaml'));
const episode = episodeInput(await read('episode.yaml'), false);
const fullPodcast = podcastInput(await read('podcast-full.yaml'));
const fullEpisode = episodeInput(await read('episode-full.yaml'), false);
const make = (p = podcast, e = episode) => addEpisode(createFeed(structuredClone(p)), structuredClone(e), new Date('2026-02-01T00:00:00Z')).xml;
const valid = xml => assert.equal(validate(xml).errors, 0, JSON.stringify(validate(xml).issues, null, 2));

test('creates RSS with escaping, UTC dates, explicit metadata and Podcasting 2.0', () => {
  const xml = make(); valid(xml);
  assert.equal(validate(xml).warnings, 0);
  assert.match(xml, /Thu, 01 Jan 2026 09:00:00 \+0000/);
  assert.match(xml, /Society &amp; Culture/);
  assert.match(xml, /<content:encoded>&lt;p&gt;/);
  assert.match(xml, /<guid isPermaLink="false">urn:uuid:/);
});

test('UUID v5 agrees with published Podcast Index test vectors', () => {
  assert.equal(uuidV5('podnews.net/rss'), '9b024349-ccf0-5f69-a609-6b82873eab3c');
  assert.equal(uuidV5('mp3s.nashownotes.com/pc20rss.xml'), '917393e3-1b1e-5cef-ace4-edaa54e1f810');
});

test('stable id gives stable GUID across date, title and media URL changes', () => {
  const a = addEpisode(createFeed(podcast), episode).guid;
  const b = addEpisode(createFeed(podcast), { ...episode, title: 'Другое', publishedAt: '2026-01-02T00:00:00Z', enclosure: { ...episode.enclosure, url: 'https://example.com/other.mp3' } }).guid;
  assert.equal(a, b);
  assert.throws(() => addEpisode(parseXml(make()), { ...episode, enclosure: { ...episode.enclosure, url: 'https://example.com/other.mp3' } }), /уже существует/);
});

test('duplicate media URL is rejected even with a different explicit GUID', () => {
  assert.throws(() => addEpisode(parseXml(make()), { ...episode, id: undefined, guid: 'another-guid' }), /уже существует/);
});

test('uses explicit GUID as-is and preserves it in later runs', () => {
  const xml = make(podcast, { ...episode, id: undefined, guid: 'existing-provider:123' });
  valid(xml); assert.match(xml, /existing-provider:123/);
});

test('appends in date order and preserves unknown namespaces, CDATA, comments and old item content', () => {
  const original = make().replace('<channel>', '<channel xmlns:vendor="urn:vendor"><vendor:custom flag="1"><![CDATA[a < b]]></vendor:custom><!-- keep -->');
  const doc = parseXml(original);
  const oldItem = select(channelOf(doc), 'item')[0];
  const oldXml = oldItem.toString();
  const e = { ...episode, id: 'two', title: 'Второй', publishedAt: '2026-01-08T00:00:00Z', enclosure: { ...episode.enclosure, url: 'https://example.com/two.mp3' } };
  const result = addEpisode(doc, e).xml; valid(result);
  assert.equal(select(channelOf(parseXml(result)), 'item')[1].toString(), oldXml); assert.match(result, /<!\[CDATA\[a < b\]\]>/); assert.match(result, /<!-- keep -->/);
  assert.equal(select(channelOf(parseXml(result)), 'item')[0].getElementsByTagName('title')[0].textContent, 'Второй');
});

test('backdated episode is appended without sorting old episodes', () => {
  const result = addEpisode(parseXml(make()), { ...episode, id: 'old', publishedAt: '2025-01-01T00:00:00Z', enclosure: { ...episode.enclosure, url: 'https://example.com/old.mp3' } });
  valid(result.xml);
  const items = select(channelOf(parseXml(result.xml)), 'item');
  assert.match(items[1].toString(), /2025/);
});

test('explicit episode raises channel explicit flag', () => {
  const result = addEpisode(createFeed(podcast), { ...episode, explicit: true });
  assert.equal(result.explicitChanged, true); valid(result.xml);
  assert.match(result.xml, /<itunes:explicit>true<\/itunes:explicit>/);
});

test('full examples cover every canonized tag plus deprecated images', () => {
  const xml = make(fullPodcast, fullEpisode); valid(xml);
  for (const name of Object.keys(podcastRules)) assert.ok(xml.includes(`<podcast:${name}`), `missing ${name}`);
  assert.equal(Object.keys(podcastRules).length, 32);
  assert.ok(validate(xml).issues.some(i => i.code === 'PODCAST_DEPRECATED'));
});

test('namespace aliases and arbitrary prefixes are understood', () => {
  const xml = make(fullPodcast, fullEpisode).replaceAll('podcast:', 'p2:').replace('xmlns:podcast=', 'xmlns:p2=').replaceAll(NS.podcast, 'https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md');
  valid(xml);
});

test('namespace prefix conflicts do not change existing vendor namespace', () => {
  const xml = make().replaceAll('podcast:', 'p2:').replace('xmlns:podcast=', 'xmlns:p2=').replace('<channel>', '<channel xmlns:podcast="urn:vendor"><podcast:thing>old</podcast:thing>');
  const result = addEpisode(parseXml(xml), { ...episode, id: 'another', enclosure: { ...episode.enclosure, url: 'https://example.com/another.mp3' } }).xml;
  valid(result);
  const doc = parseXml(result);
  assert.equal(doc.getElementsByTagNameNS('urn:vendor', 'thing').length, 1);
  assert.equal(doc.getElementsByTagNameNS(NS.podcast, 'transcript').length, 2);
});

for (const [name, transform, code] of [
  ['missing channel title', x => x.replace(/<title>[^<]*<\/title>/, ''), 'RSS_REQUIRED'],
  ['invalid length', x => x.replace('length="42817536"', 'length="-1"'), 'ENCLOSURE_LENGTH'],
  ['insecure media', x => x.replace('https://example.com/audio', 'http://example.com/audio'), 'URL_HTTPS'],
  ['wrong MIME', x => x.replace('type="audio/mpeg"', 'type="video/mp4"'), 'ENCLOSURE_TYPE'],
  ['invalid date', x => x.replace('Thu, 01 Jan 2026 09:00:00 +0000', '2026-01-01'), 'RSS_DATE'],
  ['wrong weekday', x => x.replace('Thu, 01 Jan 2026', 'Fri, 01 Jan 2026'), 'RSS_DATE'],
  ['wrong category case', x => x.replace('text="Technology"', 'text="technology"'), 'ITUNES_CATEGORY'],
  ['unknown subcategory', x => x.replace('text="Relationships"', 'text="Technology"'), 'ITUNES_SUBCATEGORY'],
  ['malformed XML', x => x.replace('</channel>', '</broken>'), 'XML_PARSE'],
  ['no encoding declaration', x => x.replace(' encoding="UTF-8"', ''), 'XML_DECLARATION'],
  ['DTD injection', x => x.replace('<rss ', '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss '), 'XML_DTD'],
  ['unknown XML entity', x => x.replace('Первый', '&bogus;'), 'XML_PARSE'],
  ['numeric null entity', x => x.replace('Первый', '&#0;'), 'XML_PARSE'],
  ['numeric surrogate entity', x => x.replace('Первый', '&#xD800;'), 'XML_PARSE'],
  ['invalid numeric entity in attribute', x => x.replace('role="host"', 'role="&#0;"'), 'XML_PARSE'],
  ['required Podcast attribute', x => x.replace('type="text/vtt"', ''), 'PODCAST_ATTRIBUTE_REQUIRED'],
  ['empty person', x => x.replace('Имя ведущего', ''), 'PODCAST_TEXT'],
  ['invalid duration', x => x.replace('duration="42"', 'duration="-2"'), 'PODCAST_ATTRIBUTE'],
  ['wrong parent', x => x.replace('</channel>', '<podcast:chapters url="https://example.com/c.json" type="application/json+chapters"/></channel>'), 'PODCAST_PARENT'],
  ['multiple chapters', x => x.replace('</item>', '<podcast:chapters url="https://example.com/c.json" type="application/json+chapters"/></item>'), 'PODCAST_COUNT'],
  ['duplicate GUID', x => x.replace('</channel>', x.match(/<item>[\s\S]*<\/item>/)[0] + '</channel>'), 'DUPLICATE_GUID'],
]) test(`validation rejects ${name}`, () => assert.ok(validate(transform(make())).issues.some(i => i.code === code), JSON.stringify(validate(transform(make())))));

for (const [name, transform, code] of [
  ['empty alternate enclosure', x => x.replace(/<podcast:source[^>]*\/>/g, ''), 'PODCAST_CHILD_REQUIRED'],
  ['publisher without correct medium', x => x.replace('medium="publisher"', 'medium="music"'), 'PODCAST_PUBLISHER'],
  ['disabled social with URI', x => x.replace('protocol="disabled"', 'protocol="disabled" uri="https://example.com/comments"'), 'PODCAST_DISABLED'],
  ['custom license without url', x => x.replace('cc-by-4.0', 'my-license'), 'PODCAST_LICENSE_URL'],
  ['live without contentLink', x => x.replace(/<podcast:contentLink href="https:\/\/example.com\/live">.*?<\/podcast:contentLink>/, ''), 'PODCAST_CHILD_REQUIRED'],
  ['incomplete RRULE', x => x.replace('FREQ=WEEKLY;BYDAY=TH', 'FREQ=WEEKLY;COUNT=10'), 'PODCAST_RRULE_START'],
  ['bad RRULE', x => x.replace('FREQ=WEEKLY;BYDAY=TH', 'FREQ=NEVER'), 'PODCAST_RRULE'],
  ['unknown RRULE component', x => x.replace('FREQ=WEEKLY;BYDAY=TH', 'FREQ=WEEKLY;toString=foo'), 'PODCAST_RRULE'],
  ['malformed live date', x => x.replace('start="2026-01-01T12:00:00+03:00"', 'start="2026-02-30T12:00:00+03:00"'), 'PODCAST_ATTRIBUTE'],
]) test(`Podcasting 2.0 rejects ${name}`, () => assert.ok(validate(transform(make(fullPodcast, fullEpisode))).issues.some(i => i.code === code)));

test('valueTimeSplit disallows mixing remoteItem and recipients', () => {
  const doc = parseXml(make(fullPodcast, fullEpisode));
  const split = doc.getElementsByTagNameNS(NS.podcast, 'valueTimeSplit')[0];
  append(split, 'podcast:valueRecipient', undefined, { type: 'lnaddress', address: 'a@example.com', split: '1' });
  assert.ok(validate(serialize(doc)).issues.some(i => i.code === 'PODCAST_TIME_SPLIT'));
});

test('aliases, duplicate keys, unknown fields and wrong types fail closed', () => {
  for (const source of ['a: &a [1]\nb: *a', 'title: a\ntitle: b', '{"title":"a","title":"b"}', 'x: !!timestamp 2026-01-01']) assert.throws(() => parseInput(source));
  assert.throws(() => episodeInput({ ...episode, typo: 1 }, false), /неизвестное поле/);
  assert.throws(() => episodeInput({ ...episode, enclosure: { ...episode.enclosure, length: '100' } }, false), /целое число/);
  assert.throws(() => episodeInput({ ...episode, explicit: 'false' }, false), /true или false/);
  assert.throws(() => episodeInput({ ...episode, duration: 1.2 }, false), /целое число/);
  assert.throws(() => episodeInput({ ...episode, title: 'hello\u0000world' }, false), /XML/);
});

test('publication date is explicit and cannot be future or in conflict with --now', () => {
  assert.throws(() => episodeInput({ ...episode, publishedAt: undefined }, false), /publishedAt/);
  assert.throws(() => episodeInput(episode, true), /нельзя использовать вместе/);
  assert.throws(() => episodeInput({ ...episode, publishedAt: '2099-01-01T00:00:00Z' }, false), /будущем/);
  assert.doesNotThrow(() => episodeInput({ ...episode, publishedAt: undefined }, true));
  for (const s of ['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T12:00:00', '2026-01-01T00:00:00+25:00']) assert.equal(isoDate(s), false);
  assert.equal(isoDate('2024-02-29T23:59:59-0500'), true);
  assert.equal(rssDate('Fri, 30 Feb 2026 09:00:00 +0000'), false);
});

test('serial shows require episode number for full episodes', () => {
  const xml = make({ ...podcast, type: 'serial' }, { ...episode, episode: undefined });
  assert.ok(validate(xml).issues.some(i => i.code === 'RSS_REQUIRED'));
});
