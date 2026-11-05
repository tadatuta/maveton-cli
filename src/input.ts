import { parseDocument } from 'yaml';
import { CliError, NS, object, string, xmlChars, isoDate } from './core.ts';
import { append } from './xml.ts';
import type { Element } from './xml.ts';

export interface Tag {
  tag: string;
  text?: string;
  attributes?: Record<string, string>;
  children?: Tag[];
}
export interface Podcast {
  title: string; description: string; link: string; language: string; author: string;
  image: string; feedUrl: string; explicit: boolean;
  owner: { name: string; email: string };
  categories: { name: string; subcategory?: string }[];
  type?: string; copyright?: string; podcast?: Tag[];
}
export interface Episode {
  id?: string; guid?: string; title: string; description: string; publishedAt?: string;
  enclosure: { url: string; length: number; type: string };
  duration?: number; explicit?: boolean; link?: string; author?: string; image?: string;
  episode?: number; season?: number; episodeType?: string; contentHtml?: string; podcast?: Tag[];
}

export function parseInput(source: string): unknown {
  const doc = parseDocument(source, { version: '1.2', strict: true, uniqueKeys: true, resolveKnownTags: false });
  if (doc.errors.length || doc.warnings.length) throw new CliError('INPUT_PARSE', [...doc.errors, ...doc.warnings].map(e => e.message).join('\n'));
  try { return doc.toJS({ maxAliasCount: 0 }) as unknown; }
  catch (e) { throw new CliError('INPUT_PARSE', `Не удалось прочитать YAML/JSON: ${String(e)}`); }
}
function optionalString(o: Record<string, unknown>, key: string, path: string): void {
  if (o[key] !== undefined) string(o[key], `${path}.${key}`);
}
function bool(o: Record<string, unknown>, key: string, required: boolean, path: string): void {
  if ((required || o[key] !== undefined) && typeof o[key] !== 'boolean') throw new CliError('INPUT_TYPE', `${path}.${key}: ожидается true или false.`);
}
function number(o: Record<string, unknown>, key: string, min: number, path: string): void {
  if (typeof o[key] !== 'number' || !Number.isSafeInteger(o[key]) || (o[key] as number) < min) throw new CliError('INPUT_TYPE', `${path}.${key}: ожидается целое число ≥ ${min}.`);
}
// Numeric YAML/JSON scalars such as 0.00000005 must not become the XML decimal "5e-8".
function scalar(value: string | number | boolean): string {
  const text = String(value);
  if (typeof value !== 'number' || !/[eE]/.test(text)) return text;
  const [coefficient, exponent] = text.toLowerCase().split('e');
  const sign = coefficient!.startsWith('-') ? '-' : '';
  const unsigned = coefficient!.replace(/^-/, '');
  const digits = unsigned.replace('.', '');
  const point = (unsigned.includes('.') ? unsigned.indexOf('.') : unsigned.length) + Number(exponent);
  return sign + (point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`);
}
function tags(value: unknown, path: string, depth = 0): Tag[] {
  if (!Array.isArray(value) || depth > 32) throw new CliError('INPUT_TAGS', `${path}: ожидается массив тегов, глубина не больше 32.`);
  return value.map((item: unknown, index: number) => {
    const p = `${path}[${index}]`;
    const o = object(item, p, ['tag', 'text', 'attributes', 'children']);
    const name = string(o.tag, `${p}.tag`);
    if (!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(name)) throw new CliError('INPUT_TAG', `${p}: недопустимое имя тега.`);
    const qualified = name.includes(':') ? name : `podcast:${name}`;
    const prefix = qualified.split(':')[0]!;
    if (prefix !== 'rss' && !Object.hasOwn(NS, prefix)) throw new CliError('INPUT_TAG', `${p}: неизвестный namespace ${prefix}.`);
    if (depth === 0 && prefix !== 'podcast') throw new CliError('INPUT_TAG', `${p}: верхний уровень podcast принимает только теги podcast:*.`);
    const result: Tag = { tag: qualified };
    if (o.text !== undefined) {
      if (!['string', 'number', 'boolean'].includes(typeof o.text) || !xmlChars(String(o.text)) || (typeof o.text === 'number' && !Number.isFinite(o.text))) throw new CliError('INPUT_TAG', `${p}.text: ожидается строка, число или boolean.`);
      result.text = scalar(o.text as string | number | boolean);
    }
    if (o.attributes !== undefined) {
      result.attributes = Object.create(null) as Record<string, string>;
      for (const [key, value] of Object.entries(object(o.attributes, `${p}.attributes`))) {
        if (!/^[A-Za-z_][\w.-]*$/.test(key) || key === 'xmlns' || !['string', 'number', 'boolean'].includes(typeof value) || !xmlChars(String(value)) || (typeof value === 'number' && !Number.isFinite(value))) throw new CliError('INPUT_TAG', `${p}.attributes.${key}: недопустимое имя или значение атрибута.`);
        result.attributes[key] = scalar(value as string | number | boolean);
      }
    }
    if (o.children !== undefined) result.children = tags(o.children, `${p}.children`, depth + 1);
    return result;
  });
}
export function podcastInput(value: unknown): Podcast {
  const o = object(value, 'podcast', ['title', 'description', 'link', 'language', 'author', 'image', 'feedUrl', 'explicit', 'owner', 'categories', 'type', 'copyright', 'podcast']);
  for (const key of ['title', 'description', 'link', 'language', 'author', 'image', 'feedUrl']) string(o[key], `podcast.${key}`);
  for (const key of ['type', 'copyright']) optionalString(o, key, 'podcast');
  bool(o, 'explicit', true, 'podcast');
  const owner = object(o.owner, 'podcast.owner', ['name', 'email']);
  string(owner.name, 'podcast.owner.name'); string(owner.email, 'podcast.owner.email');
  if (!Array.isArray(o.categories) || !o.categories.length) throw new CliError('INPUT_TYPE', 'podcast.categories: нужен непустой массив категорий.');
  for (const c of o.categories) {
    const category = object(c, 'podcast.categories[]', ['name', 'subcategory']);
    string(category.name, 'category.name'); optionalString(category, 'subcategory', 'category');
  }
  if (o.podcast !== undefined) o.podcast = tags(o.podcast, 'podcast.podcast');
  return o as unknown as Podcast;
}
export function episodeInput(value: unknown, now: boolean): Episode {
  const o = object(value, 'episode', ['id', 'guid', 'title', 'description', 'publishedAt', 'enclosure', 'duration', 'explicit', 'link', 'author', 'image', 'episode', 'season', 'episodeType', 'contentHtml', 'podcast']);
  string(o.title, 'episode.title'); string(o.description, 'episode.description');
  for (const key of ['id', 'guid', 'link', 'author', 'image', 'episodeType', 'contentHtml']) optionalString(o, key, 'episode');
  if (o.id !== undefined && o.guid !== undefined) throw new CliError('INPUT_GUID', 'Задайте либо id, либо guid.');
  if (now && o.publishedAt !== undefined) throw new CliError('INPUT_DATE', '--now и publishedAt нельзя использовать вместе.');
  if (!now && (typeof o.publishedAt !== 'string' || !isoDate(o.publishedAt))) throw new CliError('INPUT_DATE', 'Нужен publishedAt в ISO 8601 с часовым поясом (2026-11-06T12:00:00+03:00) или --now.');
  if (!now && Date.parse(o.publishedAt as string) > Date.now()) throw new CliError('INPUT_FUTURE', 'Дата выпуска в будущем: отложенная публикация не поддерживается.');
  bool(o, 'explicit', false, 'episode');
  for (const key of ['duration', 'episode', 'season']) if (o[key] !== undefined) number(o, key, 1, 'episode');
  const enclosure = object(o.enclosure, 'episode.enclosure', ['url', 'length', 'type']);
  string(enclosure.url, 'episode.enclosure.url'); string(enclosure.type, 'episode.enclosure.type'); number(enclosure, 'length', 1, 'episode.enclosure');
  if (o.podcast !== undefined) o.podcast = tags(o.podcast, 'episode.podcast');
  return o as unknown as Episode;
}
export function appendTags(parent: Element, tags: Tag[] = []): void {
  for (const tag of tags) appendTags(append(parent, tag.tag, tag.text, tag.attributes), tag.children);
}
