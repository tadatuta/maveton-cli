import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFeed, writeAtomic, readLocal, FEED_LIMIT } from '../dist/io.js';

const cli = resolve('dist/cli.js');
const podcast = resolve('examples/podcast.yaml');
const episode = resolve('examples/episode.yaml');
const second = resolve('examples/episode.json');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'maveton-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function fixture(t) { const dir = await directory(t); const file = join(dir, 'rss.xml'); const result = run('add', '--podcast', podcast, '--episode', episode, '--output', file, '--json'); assert.equal(result.status, 0, result.stdout + result.stderr); return { dir, file }; }

test('init produces templates; refuses existing files without changing them', async t => {
  const dir = await directory(t);
  const result = run('init', '--directory', dir, '--json'); assert.equal(result.status, 0, result.stdout);
  const before = await readFile(join(dir, 'podcast.yaml'), 'utf8');
  assert.equal(run('init', '--directory', dir).status, 2);
  assert.equal(await readFile(join(dir, 'podcast.yaml'), 'utf8'), before);
  assert.equal(run('add', '--podcast', join(dir, 'podcast.yaml'), '--episode', join(dir, 'episode.yaml'), '--output', join(dir, 'rss.xml')).status, 0);
});

test('add then validate, including JSON reports and codes', async t => {
  const { file } = await fixture(t);
  const result = run('validate', '--feed', file, '--strict', '--json');
  assert.equal(result.status, 0, result.stdout);
  const data = JSON.parse(result.stdout); assert.equal(data.valid, true); assert.equal(data.episodes, 1); assert.equal(data.scope, 'local'); assert.ok(data.unchecked.length);
});

test('overwrite needs explicit flag and backup contains exact old bytes', async t => {
  const { dir, file } = await fixture(t);
  const old = await readFile(file);
  const args = ['add', '--feed', file, '--episode', second, '--output', file, '--json'];
  assert.equal(run(...args).status, 2); assert.deepEqual(await readFile(file), old);
  const result = run(...args, '--overwrite'); assert.equal(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout); assert.deepEqual(await readFile(report.written.backup), old);
  assert.equal(report.validation.episodes, 2);
  assert.ok((await readdir(dir)).every(f => !f.endsWith('.tmp') && !f.endsWith('.lock')));
});

test('repeat run fails, leaves source untouched and creates no new backup', async t => {
  const { dir, file } = await fixture(t); const old = await readFile(file);
  const result = run('add', '--feed', file, '--episode', episode, '--output', file, '--overwrite', '--json');
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.code, 'DUPLICATE_EPISODE');
  assert.deepEqual(await readFile(file), old); assert.deepEqual(await readdir(dir), ['rss.xml']);
});

test('dry-run does not create files or backups; stdout preview is valid XML', async t => {
  const { dir, file } = await fixture(t); const old = await readFile(file);
  const args = ['add', '--feed', file, '--episode', second, '--dry-run'];
  assert.equal(run(...args, '--output', file, '--overwrite').status, 0);
  assert.deepEqual(await readdir(dir), ['rss.xml']); assert.deepEqual(await readFile(file), old);
  const preview = run(...args, '--output', '-'); assert.equal(preview.status, 0); assert.match(preview.stdout, /^<\?xml/); assert.ok(!preview.stdout.includes('Готово:'));
  const target = join(dir, 'new.xml'); assert.equal(run(...args, '--output', target, '--json').status, 0); assert.deepEqual(await readdir(dir), ['rss.xml']);
});

test('strict treats warnings as failure and never writes output', async t => {
  const dir = await directory(t); const input = join(dir, 'episode.json');
  const obj = JSON.parse(await readFile(second, 'utf8')); delete obj.duration;
  await writeFile(input, JSON.stringify(obj));
  const result = run('add', '--podcast', podcast, '--episode', input, '--output', join(dir, 'rss.xml'), '--strict', '--json');
  assert.equal(result.status, 1, result.stdout); const report = JSON.parse(result.stdout);
  assert.equal(report.validation.valid, true); assert.equal(report.ok, false); assert.deepEqual(await readdir(dir), ['episode.json']);
});

test('invalid existing feed blocks writes and malformed XML exits 1', async t => {
  const dir = await directory(t); const feed = join(dir, 'bad.xml'); await writeFile(feed, '<rss><broken></rss>');
  assert.equal(run('validate', '--feed', feed).status, 1);
  assert.equal(run('add', '--feed', feed, '--episode', second, '--output', join(dir, 'out.xml')).status, 1);
  assert.deepEqual(await readdir(dir), ['bad.xml']);
});

test('missing inputs and incompatible options exit 2 as JSON', () => {
  for (const args of [['add'], ['validate'], ['init', '--feed', 'x'], ['add', '--episode', episode, '--podcast', podcast, '--output', '-', '--json'], ['validate', '--feed', '/does/not/exist'], ['wat'], ['add', '--typo']]) {
    const result = run(...args, '--json'); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).ok, false);
  }
});

test('stdout output cannot overwrite YAML input; symlink output is refused', async t => {
  const dir = await directory(t); const input = join(dir, 'episode.json'); await writeFile(input, await readFile(second));
  const args = ['add', '--podcast', podcast, '--episode', input, '--overwrite'];
  assert.equal(run(...args, '--output', input).status, 2);
  const target = join(dir, 'target'); await writeFile(target, 'original');
  const sym = join(dir, 'link'); await symlink(target, sym);
  assert.equal(run(...args, '--output', sym).status, 2); assert.equal(await readFile(target, 'utf8'), 'original');
});

test('write lock prevents lost updates and stale source snapshots are refused', async t => {
  const dir = await directory(t); const file = join(dir, 'rss.xml'); await writeFile(file, 'new');
  await assert.rejects(writeAtomic(file, 'replacement', { overwrite: true, sourceSnapshot: { path: file, content: 'old' } }), /изменился/);
  await writeFile(file + '.maveton.lock', '123\n');
  await assert.rejects(writeAtomic(file, 'replacement', { overwrite: true }), /занят/);
  assert.equal(await readFile(file, 'utf8'), 'new');
});

test('two concurrent non-overwriting writes cannot clobber each other', async t => {
  const dir = await directory(t); const file = join(dir, 'out');
  const results = await Promise.allSettled([writeAtomic(file, 'one'), writeAtomic(file, 'two')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['one', 'two'].includes(await readFile(file, 'utf8')));
});

test('local input bounds and invalid UTF-8 are enforced', async t => {
  const dir = await directory(t); const file = join(dir, 'data'); await writeFile(file, '12345');
  await assert.rejects(readLocal(file, 4), /лимит/);
  await writeFile(file, Buffer.from([0xff, 0xfe])); await assert.rejects(readLocal(file), /UTF-8/);
});

test('HTTPS feed retrieval follows redirects and only requests RSS', async () => {
  const calls = [];
  const xml = '<rss><channel><enclosure url="https://example.com/media.mp3"/></channel></rss>';
  const fetcher = async url => { calls.push(url); return calls.length === 1 ? new Response('', { status: 302, headers: { location: '/actual.xml' } }) : new Response(xml); };
  assert.equal(await readFeed('https://example.com/rss', fetcher), xml);
  assert.deepEqual(calls, ['https://example.com/rss', 'https://example.com/actual.xml']);
});

test('HTTP downgrade, redirect loops, oversized and HTTP error responses fail', async () => {
  await assert.rejects(readFeed('http://example.com/rss'), /HTTPS/);
  await assert.rejects(readFeed('https://example.com/rss', async () => new Response('', { status: 302, headers: { location: 'http://example.com/rss' } })), /HTTPS/);
  await assert.rejects(readFeed('https://example.com/rss', async () => new Response('', { status: 302, headers: { location: '/again' } })), /перенаправлений/);
  await assert.rejects(readFeed('https://example.com/rss', async () => new Response('', { headers: { 'content-length': String(FEED_LIMIT + 1) } })), /20 MiB/);
  await assert.rejects(readFeed('https://example.com/rss', async () => new Response('oops', { status: 503 })), /HTTP 503/);
  await assert.rejects(readFeed('https://example.com/rss', async () => new Response('x'.repeat(FEED_LIMIT + 1))), /20 MiB/);
});


test('missing episode link warns normally and strict blocks creation and overwrite', async t => {
  const { dir, file } = await fixture(t);
  const input = join(dir, 'missing-link.json');
  const obj = JSON.parse(await readFile(second, 'utf8')); delete obj.link;
  await writeFile(input, JSON.stringify(obj));
  const before = await readFile(file);
  const entries = (await readdir(dir)).sort();
  for (const output of [join(dir, 'new.xml'), file]) {
    const args = ['add', '--feed', file, '--episode', input, '--output', output, '--strict', '--json'];
    if (output === file) args.push('--overwrite');
    const result = run(...args); const report = JSON.parse(result.stdout);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(report.ok, false); assert.equal(report.validation.valid, true);
    assert.equal(report.validation.errors, 0); assert.equal(report.validation.warnings, 1);
    assert.equal(report.validation.issues[0].code, 'RSS_ITEM_LINK_MISSING');
    assert.equal(report.written, undefined);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual((await readdir(dir)).sort(), entries, 'no output, backup, lock or temp files');
  }
  const output = join(dir, 'ordinary.xml');
  const ordinary = run('add', '--feed', file, '--episode', input, '--output', output, '--json');
  const report = JSON.parse(ordinary.stdout);
  assert.equal(ordinary.status, 0, ordinary.stdout); assert.equal(report.ok, true);
  assert.equal(report.validation.warnings, 1); assert.equal(report.validation.issues[0].code, 'RSS_ITEM_LINK_MISSING');
  assert.equal(report.written.output, await realpath(output));
  for (const strict of [false, true]) {
    const result = run('validate', '--feed', output, '--json', ...(strict ? ['--strict'] : []));
    assert.equal(result.status, strict ? 1 : 0, result.stdout);
    const validation = JSON.parse(result.stdout);
    assert.equal(validation.valid, true); assert.equal(validation.ok, !strict);
    assert.equal(validation.issues[0].code, 'RSS_ITEM_LINK_MISSING');
  }
  const existing = await readFile(output); const existingEntries = (await readdir(dir)).sort();
  const rejected = run('add', '--feed', output, '--episode', episode, '--output', output, '--overwrite', '--strict', '--json');
  assert.equal(rejected.status, 1); assert.equal(JSON.parse(rejected.stdout).phase, 'source');
  assert.deepEqual(await readFile(output), existing);
  assert.deepEqual((await readdir(dir)).sort(), existingEntries);
});
