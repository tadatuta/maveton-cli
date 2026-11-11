import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeed, addEpisode } from '../dist/feed.js';
import { parseInput, podcastInput, episodeInput } from '../dist/input.js';
import { parseXml, select, textOf, channelOf, serialize } from '../dist/xml.js';
import { validate } from '../dist/validate.js';
import { validatePodcastTree } from '../dist/podcast.js';
import { recurrenceErrors } from '../dist/recurrence.js';
import { NS, language, FEED_LIMIT, httpsUrl, uri } from '../dist/core.js';
import { readLocal, writeAtomic, sameFile } from '../dist/io.js';

const p = podcastInput(parseInput(await fs.readFile('examples/podcast.yaml', 'utf8')));
const e = episodeInput(parseInput(await fs.readFile('examples/episode.yaml', 'utf8')), false);
const second = episodeInput(parseInput(await fs.readFile('examples/episode.json', 'utf8')), false);
const base = () => addEpisode(createFeed(p), e).xml;
const errors = xml => validate(xml).issues.filter(issue => issue.severity === 'error');
const valid = xml => assert.deepEqual(errors(xml), []);
const withChannel = snippet => base().replace('</channel>', `${snippet}</channel>`);
const withItem = snippet => base().replace('</item>', `${snippet}</item>`);
const live = '<podcast:liveItem status="ended" start="2026-01-01T00:00:00Z"><title>Live</title><guid isPermaLink="false">live-1</guid><enclosure url="https://example.com/live" type="audio/mpeg" length="0"/><podcast:contentLink href="https://example.com/live"/></podcast:liveItem>';
const run = (...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { encoding: 'utf8', timeout: 10_000 });
async function directory(t) { const path = await fs.mkdtemp(join(tmpdir(), 'maveton-review-')); t.after(() => fs.rm(path, { recursive: true, force: true })); return path; }

test('strict XML rejects attributes with duplicate expanded names before DOM can drop one', () => {
  const xml = base().replace('role="host"', 'xmlns:a="urn:test" xmlns:b="urn:test" a:id="1" b:id="2" role="host"');
  assert.ok(errors(xml).some(i => i.code === 'XML_PARSE'));
});

test('DTD-like content inside CDATA and comments is legitimate text', () => {
  valid(base().replace('Первый выпуск — знакомимся', '<![CDATA[Обсуждаем <!DOCTYPE rss> и <!ENTITY example>]]>'));
  valid(base().replace('</channel>', '<!-- <!DOCTYPE rss> --></channel>'));
  assert.ok(errors(base().replace('<rss ', '<!DOCTYPE rss><rss ')).some(i => i.code === 'XML_DTD'));
});

test('XML namespace bindings and duplicate namespace attributes are enforced', () => {
  for (const attr of ['xmlns:xml="urn:wrong"', 'xmlns:xmlns="urn:wrong"', 'xmlns:p="urn:a" xmlns:p="urn:b"']) {
    assert.ok(errors(base().replace('<channel>', `<channel ${attr}>`)).some(i => i.code === 'XML_PARSE'));
  }
});

test('namespace identity matters for Podcasting 2.0 parents, not just local name', () => {
  const samples = [
    '<value><podcast:valueRecipient type="lnaddress" address="a@example.com" split="1"/></value>',
    '<publisher><podcast:remoteItem feedGuid="9b024349-ccf0-5f69-a609-6b82873eab3c"/></publisher>',
    '<podcast:channel><podcast:locked>yes</podcast:locked></podcast:channel>',
    '<podcast:item><podcast:chapters url="https://example.com/c.json" type="application/json+chapters"/></podcast:item>',
  ];
  for (const snippet of samples) assert.ok(errors(withChannel(snippet)).some(i => i.code === 'PODCAST_PARENT'), snippet);
});

test('valid nested blocks and namespace aliases retain their correct parents', () => {
  const xml = withItem('<podcast:value type="lightning" method="lnaddress"><podcast:valueRecipient type="lnaddress" address="a@example.com" split="1"/><podcast:valueTimeSplit startTime="1" duration="2"><podcast:valueRecipient type="lnaddress" address="b@example.com" split="1"/></podcast:valueTimeSplit></podcast:value>');
  valid(xml);
  valid(xml.replaceAll('podcast:', 'other:').replace('xmlns:podcast=', 'xmlns:other='));
});

test('liveItem allows item fields, but rejects channel and nested item fields', () => {
  valid(withChannel(live));
  for (const invalid of ['<channel/>', '<item/>', '<language>ru</language>']) {
    assert.ok(errors(withChannel(live.replace('</podcast:liveItem>', `${invalid}</podcast:liveItem>`))).some(i => i.code === 'RSS_ELEMENT'));
  }
  const noMime = live.replace('type="audio/mpeg"', '');
  assert.ok(errors(withChannel(noMime)).some(i => i.code === 'ENCLOSURE_TYPE'));
});

test('empty optional fields and nonempty enclosure/image are rejected', () => {
  for (const xml of [
    base().replace('<itunes:episode>1</itunes:episode>', '<itunes:episode/>'),
    base().replace('<itunes:episodeType>full</itunes:episodeType>', '<itunes:episodeType/>'),
    base().replace('length="42817536" type="audio/mpeg"/>', 'length="42817536" type="audio/mpeg">oops</enclosure>'),
    base().replace('href="https://example.com/podcast/cover.jpg"/>', 'href="https://example.com/podcast/cover.jpg">oops</itunes:image>'),
  ]) assert.ok(errors(xml).length > 0);
});

test('diagnostics identify the exact episode number', () => {
  const xml = addEpisode(parseXml(base()), second).xml.replace('<title>Второй выпуск</title>', '<title/>');
  assert.ok(errors(xml).some(i => i.path === 'channel/item[1]/title'));
});

test('small YAML/JSON numbers serialize as decimals, including text and attributes', () => {
  const input = episodeInput({ ...e, podcast: [{ tag: 'value', attributes: { type: 'lightning', method: 'keysend', suggested: 0.00000005 }, children: [{ tag: 'valueRecipient', attributes: { type: 'lnaddress', address: 'a@example.com', split: 100 } }] }, { tag: 'episode', text: 1e-7 }] }, false);
  const xml = addEpisode(createFeed(p), input).xml;
  valid(xml); assert.match(xml, /suggested="0\.00000005"/); assert.match(xml, /<podcast:episode>0\.0000001<\/podcast:episode>/);
});

test('special attribute names survive input conversion and are not silently discarded', () => {
  const raw = parseInput('tag: txt\nattributes:\n  __proto__: preserved\ntext: hello');
  const input = episodeInput({ ...e, podcast: [raw] }, false);
  const xml = addEpisode(createFeed(p), input).xml;
  assert.match(xml, /__proto__="preserved"/);
  assert.ok(validate(xml).issues.some(i => i.code === 'PODCAST_UNKNOWN_ATTRIBUTE'));
});

for (const [name, rule, start] of [
  ['impossible date', 'FREQ=DAILY;UNTIL=20260230', ''],
  ['impossible time', 'FREQ=DAILY;UNTIL=20260101T256199Z', ''],
  ['ordinal weekday in weekly', 'FREQ=WEEKLY;BYDAY=1MO', ''],
  ['ordinal weekday with week number', 'FREQ=YEARLY;BYDAY=1MO;BYWEEKNO=1', ''],
  ['year day in monthly', 'FREQ=MONTHLY;BYYEARDAY=1', ''],
  ['clock components for DATE', 'FREQ=DAILY;BYHOUR=12', '2026-01-01'],
  ['UNTIL missing UTC for zoned start', 'FREQ=DAILY;UNTIL=20261231T120000', '2026-01-01T12:00:00+03:00'],
  ['duplicate part', 'FREQ=DAILY;FREQ=WEEKLY', ''],
  ['COUNT and UNTIL', 'FREQ=DAILY;COUNT=3;UNTIL=20261231', '2026-01-01'],
]) test(`RRULE rejects ${name}`, () => assert.ok(recurrenceErrors(rule, start).length > 0));

test('RRULE accepts compact/extended dates, leap day, case-insensitive tokens and ordinal days', () => {
  for (const [rule, start] of [
    ['FREQ=DAILY;UNTIL=20240229', '2024-01-01'],
    ['FREQ=MONTHLY;BYDAY=-1MO;COUNT=3', '2026-01-01T12:00:00Z'],
    ['freq=yearly;byday=+01mo;bymonth=1', ''],
    ['FREQ=DAILY;UNTIL=2026-12-31T00:00:00.000Z', '2026-01-01T12:00:00+03:00'],
    ['FREQ=DAILY;UNTIL=20261231T000000Z', '2026-01-01T12:00:00Z'],
  ]) assert.deepEqual(recurrenceErrors(rule, start), [], rule);
});

test('BCP 47 accepts private use, grandfathered tags, extlang and rejects repeated subtags', () => {
  for (const s of ['ru', 'en-US', 'x-studio', 'i-klingon', 'zh-cmn-Hans-CN', 'de-CH-1901', 'en-u-ca-gregory']) assert.equal(language(s), true, s);
  for (const s of ['en_US', 'x', 'en-1901-1901', 'en-a-abc-a-def', 'en--US']) assert.equal(language(s), false, s);
});

test('URI checks reject repaired backslashes and bad escapes, allow uppercase schemes', () => {
  assert.equal(httpsUrl('HTTPS://example.com/a'), true);
  for (const s of ['https:///example.com/a', 'https://example.com/a\\b', 'https://example.com/<x>', 'https://example.com/%xx', 'ipfs://a/%zz']) assert.equal(uri(s), false, s);
});

test('permalink GUIDs require real HTTP(S) URLs and feed UUID ignores scheme case', () => {
  const replaceGuid = value => base().replace(/<guid isPermaLink="false">[^<]*<\/guid>/, `<guid isPermaLink="true">${value}</guid>`);
  for (const value of ['http://example.com/ep', 'HTTPS://example.com/ep']) valid(replaceGuid(value));
  for (const value of ['https://', 'https:///example.com/ep', 'https://example.com/%zz']) assert.ok(errors(replaceGuid(value)).some(i => i.code === 'GUID_PERMALINK'));
  const guid = feedUrl => textOf(channelOf(createFeed({ ...p, feedUrl })), 'guid', NS.podcast);
  assert.equal(guid('HTTPS://example.com/feed.xml'), guid('https://example.com/feed.xml'));
});

test('geo validates altitude and uncertainty, including legitimate CRS and parameters', () => {
  for (const value of ['geo:55.7,37.6,100;crs=wgs84;u=5', 'geo:-27.8,153.3;name=some%20place']) valid(withItem(`<podcast:location geo="${value}">Место</podcast:location>`));
  for (const value of ['geo:55,37,..', 'geo:55,37;u=-1', 'geo:55,37;u=1;u=2', 'geo:91,181', 'geo:55,37;crs=']) assert.ok(errors(withItem(`<podcast:location geo="${value}">Место</podcast:location>`)).some(i => i.code === 'PODCAST_ATTRIBUTE'));
});

test('images accept CSS literal ratios, empty alt, comma in URL and valid SRI options', () => {
  for (const value of ['auto', '16/9', '.5 / 1', 'auto 16/9', '16/9 auto']) valid(withItem(`<podcast:image href="https://example.com/art.jpg" alt="" aspect-ratio="${value}"/>`));
  assert.ok(errors(withItem('<podcast:image href="https://example.com/art.jpg" aspect-ratio="auto 16/9 auto"/>')).length);
  valid(withItem('<podcast:images srcset="https://example.com/a,b.jpg 600w, https://example.com/c.jpg 1200w"/>'));
  const hash = Buffer.alloc(32, 255).toString('base64url');
  valid(withItem(`<podcast:alternateEnclosure type="audio/opus"><podcast:source uri="ipfs://example"/><podcast:integrity type="sri" value=" sha256-${hash}?future-option "/></podcast:alternateEnclosure>`));
  assert.ok(errors(withItem('<podcast:images srcset="https://example.com/a.jpg 600w, https://example.com/b.jpg 600w"/>')).length);
});

test('publisher/list requirements are checked separately from the platform profile', () => {
  const minimal = value => parseXml(`<rss xmlns:podcast="${NS.podcast}"><channel><podcast:medium>${value}</podcast:medium></channel></rss>`).documentElement;
  assert.ok(validatePodcastTree(minimal('publisher')).some(i => i.code === 'PODCAST_PUBLISHER_REQUIRED'));
  assert.ok(validatePodcastTree(minimal('podcastL')).some(i => i.code === 'PODCAST_MEDIUM_REMOTE'));
});

test('raising explicit preserves the effective rating of older episodes and liveItems', () => {
  const xml = withChannel(live).replace(/(<item>.*?<itunes:episodeType>full<\/itunes:episodeType>)<itunes:explicit>false<\/itunes:explicit>/s, '$1');
  const original = parseXml(xml); const originalText = serialize(original);
  const result = addEpisode(original, { ...second, explicit: true });
  valid(result.xml); assert.equal(result.explicitPreserved, 2);
  const channel = channelOf(parseXml(result.xml));
  assert.equal(textOf(channel, 'explicit', NS.itunes), 'true');
  assert.equal(textOf(select(channel, 'item')[1], 'explicit', NS.itunes), 'false');
  assert.equal(textOf(select(channel, 'liveItem', NS.podcast)[0], 'explicit', NS.itunes), 'false');
  assert.equal(serialize(original), originalText, 'caller DOM is immutable');
});

test('failed additions leave the caller DOM untouched, and live GUIDs also block duplicates', () => {
  const original = parseXml(withChannel(live)); const originalText = serialize(original);
  assert.throws(() => addEpisode(original, { ...second, id: undefined, guid: 'live-1' }), /уже существует/);
  assert.throws(() => addEpisode(original, { ...second, podcast: [{ tag: 'unknown:tag' }] }), /namespace/);
  assert.equal(serialize(original), originalText);
});

test('invalid source metadata cannot be silently repaired by add before validation', async t => {
  const dir = await directory(t); const source = join(dir, 'feed.xml');
  const old = base().replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, '<lastBuildDate>not a date</lastBuildDate>');
  await fs.writeFile(source, old);
  const result = run('add', '--feed', source, '--episode', 'examples/episode.json', '--output', source, '--overwrite', '--json');
  assert.equal(result.status, 1, result.stdout); assert.equal(JSON.parse(result.stdout).phase, 'source');
  assert.equal(await fs.readFile(source, 'utf8'), old); assert.deepEqual(await fs.readdir(dir), ['feed.xml']);
});

test('symlinked input descriptions cannot be overwritten through their real path', async t => {
  const dir = await directory(t); const input = join(dir, 'episode.json'); const alias = join(dir, 'alias.json');
  const bytes = await fs.readFile('examples/episode.json'); await fs.writeFile(input, bytes); await fs.symlink(input, alias);
  assert.equal(await sameFile(input, alias), true);
  const result = run('add', '--podcast', 'examples/podcast.yaml', '--episode', alias, '--output', input, '--overwrite', '--json');
  assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).error.code, 'OUTPUT_INPUT');
  assert.deepEqual(await fs.readFile(input), bytes);
});

test('output source is rechecked after preparing the temporary file', async t => {
  const dir = await directory(t); const source = join(dir, 'source'); const output = join(dir, 'output');
  await fs.writeFile(source, 'original'); await fs.writeFile(output, 'old output');
  const open = fs.open.bind(fs); let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.tmp') && !changed) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => { await sync(); changed = true; await fs.writeFile(source, 'new source'); });
    }
    return handle;
  });
  await assert.rejects(writeAtomic(output, 'replacement', { overwrite: true, sourceSnapshot: { path: source, content: 'original' } }), e => e.code === 'SOURCE_CHANGED');
  assert.equal(await fs.readFile(output, 'utf8'), 'old output');
  assert.ok((await fs.readdir(dir)).every(path => !path.endsWith('.tmp') && !path.endsWith('.lock')));
});

test('an external edit with restored mtime is detected; backup keeps original bytes', async t => {
  const dir = await directory(t); const output = join(dir, 'output'); await fs.writeFile(output, 'original');
  const stat = await fs.stat(output); const open = fs.open.bind(fs); let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.tmp') && !changed) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => { await sync(); changed = true; await fs.writeFile(output, 'external'); await fs.utimes(output, stat.atime, stat.mtime); });
    }
    return handle;
  });
  await assert.rejects(writeAtomic(output, 'replacement', { overwrite: true }), e => e.code === 'OUTPUT_CHANGED');
  assert.equal(await fs.readFile(output, 'utf8'), 'external');
  const backup = (await fs.readdir(dir)).find(path => path.includes('.bak-'));
  assert.equal(await fs.readFile(join(dir, backup), 'utf8'), 'original');
});

test('post-commit sync failure explicitly reports that the output was already written', async t => {
  const dir = await directory(t); const output = join(dir, 'output'); const open = fs.open.bind(fs);
  const canonicalDir = await fs.realpath(dir);
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === canonicalDir) t.mock.method(handle, 'sync', async () => { throw new Error('injected fsync failure'); });
    return handle;
  });
  await assert.rejects(writeAtomic(output, 'committed'), e => e.code === 'OUTPUT_COMMITTED');
  assert.equal(await fs.readFile(output, 'utf8'), 'committed');
  assert.deepEqual(await fs.readdir(dir), ['output']);
});

test('special FIFO input fails immediately rather than hanging on open', async t => {
  const dir = await directory(t); const fifo = join(dir, 'fifo'); execFileSync('mkfifo', [fifo]);
  const result = run('validate', '--feed', fifo, '--json');
  assert.equal(result.error, undefined); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).error.code, 'INPUT_FILE');
});

test('UTF-8 BOM is kept in snapshots and oversized output is rejected before writes', async t => {
  const dir = await directory(t); const source = join(dir, 'source'); await fs.writeFile(source, '\uFEFFhello');
  assert.equal(await readLocal(source), '\uFEFFhello');
  const huge = 'x'.repeat(FEED_LIMIT + 1);
  assert.equal(validate(huge).issues[0].code, 'FEED_SIZE');
  await assert.rejects(writeAtomic(join(dir, 'out'), huge), e => e.code === 'FEED_SIZE');
  assert.deepEqual(await fs.readdir(dir), ['source']);
});


test('missing liveItem link does not trigger the episode website warning', () => {
  const report = validate(withChannel(live));
  assert.equal(report.errors, 0);
  assert.ok(!report.issues.some(issue => issue.code === 'RSS_ITEM_LINK_MISSING'));
});
