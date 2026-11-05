import { createHash } from 'node:crypto';
import { CliError, NS, toRssDate } from './core.ts';
import { parseXml, channelOf, append, select, textOf, serialize } from './xml.ts';
import type { Document } from './xml.ts';
import { appendTags } from './input.ts';
import type { Podcast, Episode } from './input.ts';

export function uuidV5(name: string, namespace = 'ead4c236-bf58-58c6-a2c6-a6b28d128cb6'): string {
  const hash = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(name).digest().subarray(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function createFeed(config: Podcast): Document {
  const doc = parseXml(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" ${Object.entries(NS).map(([k, v]) => `xmlns:${k}="${v}"`).join(' ')}><channel/></rss>`);
  const channel = channelOf(doc);
  for (const key of ['title', 'description', 'link', 'language'] as const) append(channel, key, config[key]);
  append(channel, 'itunes:author', config.author);
  append(channel, 'itunes:explicit', String(config.explicit));
  append(channel, 'itunes:type', config.type ?? 'episodic');
  append(channel, 'itunes:image', undefined, { href: config.image });
  const owner = append(channel, 'itunes:owner');
  append(owner, 'itunes:name', config.owner.name); append(owner, 'itunes:email', config.owner.email);
  for (const category of config.categories) {
    const cat = append(channel, 'itunes:category', undefined, { text: category.name });
    if (category.subcategory) append(cat, 'itunes:category', undefined, { text: category.subcategory });
  }
  const image = append(channel, 'image');
  append(image, 'url', config.image); append(image, 'title', config.title); append(image, 'link', config.link);
  append(channel, 'atom:link', undefined, { href: config.feedUrl, rel: 'self', type: 'application/rss+xml' });
  append(channel, 'generator', 'maveton-cli/1.0.0');
  if (config.copyright) append(channel, 'copyright', config.copyright);
  appendTags(channel, config.podcast);
  if (!select(channel, 'guid', NS.podcast).length) append(channel, 'podcast:guid', uuidV5(config.feedUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')));
  return doc;
}
export function addEpisode(doc: Document, episode: Episode, now = new Date()): { xml: string; guid: string; explicitChanged: boolean } {
  const channel = channelOf(doc);
  const self = select(channel, 'link', NS.atom).find(el => el.getAttribute('rel') === 'self')?.getAttribute('href');
  const identity = textOf(channel, 'guid', NS.podcast) || self || textOf(channel, 'link');
  const guid = episode.guid ?? `urn:uuid:${uuidV5(episode.id ? `${identity}\0${episode.id}` : episode.enclosure.url)}`;
  const canonical = (s: string): string => { try { return new URL(s).href; } catch { return s; } };
  const items = select(channel, 'item');
  if (items.some(item => textOf(item, 'guid') === guid || select(item, 'enclosure').some(e => canonical(e.getAttribute('url') ?? '') === canonical(episode.enclosure.url)))) throw new CliError('DUPLICATE_EPISODE', 'Эпизод с таким GUID/id или URL аудио уже существует. Обновление выпусков не поддерживается.', 1);
  const item = append(channel, 'item');
  append(item, 'title', episode.title); append(item, 'description', episode.description);
  append(item, 'guid', guid, { isPermaLink: 'false' });
  const published = episode.publishedAt ?? now.toISOString();
  append(item, 'pubDate', toRssDate(published));
  append(item, 'enclosure', undefined, { url: episode.enclosure.url, length: String(episode.enclosure.length), type: episode.enclosure.type });
  append(item, 'itunes:episodeType', episode.episodeType ?? 'full');
  const explicit = episode.explicit ?? (textOf(channel, 'explicit', NS.itunes) === 'true');
  append(item, 'itunes:explicit', String(explicit));
  for (const key of ['duration', 'episode', 'season'] as const) if (episode[key] !== undefined) append(item, `itunes:${key}`, String(episode[key]));
  if (episode.link) append(item, 'link', episode.link);
  if (episode.author) append(item, 'itunes:author', episode.author);
  if (episode.image) append(item, 'itunes:image', undefined, { href: episode.image });
  if (episode.contentHtml) append(item, 'content:encoded', episode.contentHtml);
  appendTags(item, episode.podcast);
  // Insert by publication date without reordering any existing episodes.
  const next = items.find(old => Date.parse(textOf(old, 'pubDate')) <= Date.parse(published));
  if (next) channel.insertBefore(item, next);
  const explicitChanged = explicit && textOf(channel, 'explicit', NS.itunes) === 'false';
  if (explicitChanged) select(channel, 'explicit', NS.itunes)[0]!.textContent = 'true';
  const buildDates = select(channel, 'lastBuildDate');
  if (buildDates.length === 1) buildDates[0]!.textContent = toRssDate(now);
  else if (!buildDates.length) append(channel, 'lastBuildDate', toRssDate(now));
  return { xml: serialize(doc), guid, explicitChanged };
}
