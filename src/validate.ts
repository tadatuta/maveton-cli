import { CliError, NS, httpsUrl, email, language, integer, rssDate, isPodcast, mime, FEED_LIMIT } from './core.ts';
import type { Issue } from './core.ts';
import { parseXml, channelOf, select, textOf, children } from './xml.ts';
import type { Element } from './xml.ts';
import { validatePodcastTree } from './podcast.ts';
import { categories } from './categories.ts';

export interface ValidationReport {
  valid: boolean;
  errors: number;
  warnings: number;
  episodes: number;
  issues: Issue[];
  scope: 'local';
  unchecked: string[];
}
export function validate(xml: string): ValidationReport {
  const issues: Issue[] = [];
  let episodes = 0;
  const add = (code: string, path: string, message: string, severity: Issue['severity'] = 'error'): void => { issues.push({ severity, code, path, message }); };
  try {
    if (Buffer.byteLength(xml, 'utf8') > FEED_LIMIT) throw new CliError('FEED_SIZE', 'Результат RSS превышает лимит 20 MiB; такой файл нельзя прочитать следующим запуском.', 1);
    const doc = parseXml(xml);
    const channel = channelOf(doc);
    const root = doc.documentElement!;
    const paths = new WeakMap<Element, string>([[channel, 'channel'], [root, '/rss']]);
    function structure(parent: Element, names: string[], path: string): void {
      for (const child of children(parent)) {
        if (!child.namespaceURI && !names.includes(child.localName!)) add('RSS_ELEMENT', `${path}/${child.tagName}`, 'Недопустимый элемент RSS в этом контексте; расширения требуют namespace.');
      }
      if (Array.from(parent.childNodes).some(n => (n.nodeType === 3 || n.nodeType === 4) && n.nodeValue?.trim())) add('RSS_TEXT', path, 'Текст вне дочерних элементов недопустим.');
    }
    function empty(el: Element, path: string): void {
      if (children(el).length || el.textContent?.trim()) add('RSS_EMPTY_ELEMENT', path, 'Этот элемент должен содержать только атрибуты.');
    }
    structure(root, ['channel'], '/rss');
    structure(channel, ['title', 'link', 'description', 'language', 'copyright', 'managingEditor', 'webMaster', 'pubDate', 'lastBuildDate', 'category', 'generator', 'docs', 'cloud', 'ttl', 'image', 'rating', 'textInput', 'skipHours', 'skipDays', 'item'], 'channel');
    if (!/^\uFEFF?<\?xml\s[^?]*version\s*=\s*["']1\.0["'][^?]*encoding\s*=\s*["']UTF-8["']/i.test(xml)) add('XML_DECLARATION', '/rss', 'Нужна декларация XML 1.0 с encoding="UTF-8".');
    function field(parent: Element, name: string, ns = '', required = true): string {
      const els = select(parent, name, ns);
      const value = els[0]?.textContent?.trim() ?? '';
      const path = `${paths.get(parent) ?? parent.localName}/${ns ? 'itunes:' : ''}${name}`;
      if (els.length > 1) add('RSS_CARDINALITY', path, 'Допускается только один элемент.');
      if (required && (!els.length || !value)) add('RSS_REQUIRED', path, 'Обязательное поле отсутствует или пусто.');
      else if (els.length && !value) add('RSS_EMPTY', path, 'Если необязательное поле задано, оно не должно быть пустым.');
      if (els.some(el => children(el).length)) add('RSS_TEXT', path, 'Ожидается текст; HTML нужно экранировать или поместить в CDATA.');
      return value;
    }
    const url = (value: string, path: string): void => { if (!httpsUrl(value)) add('URL_HTTPS', path, 'Нужен абсолютный HTTPS URL без пробелов, логина и пароля; Unicode должен быть percent-encoded.'); };
    for (const name of ['title', 'description']) field(channel, name);
    url(field(channel, 'link'), 'channel/link');
    if (!language(field(channel, 'language'))) add('RSS_LANGUAGE', 'channel/language', 'Некорректный языковой тег BCP 47.');
    field(channel, 'author', NS.itunes);
    const channelExplicit = field(channel, 'explicit', NS.itunes);
    if (!['true', 'false'].includes(channelExplicit)) add('ITUNES_EXPLICIT', 'channel/itunes:explicit', 'Для общего профиля Apple/Spotify используйте true или false.');
    const type = field(channel, 'type', NS.itunes, false);
    if (type && !['episodic', 'serial'].includes(type)) add('ITUNES_TYPE', 'channel/itunes:type', 'Допускается episodic или serial.');
    const owners = select(channel, 'owner', NS.itunes);
    if (owners.length > 1) add('RSS_CARDINALITY', 'channel/itunes:owner', 'Допускается один owner.');
    if (!owners.length) add('OWNER_MISSING', 'channel/itunes:owner', 'Контакт владельца нужен для подтверждения владения фидом.', 'warning');
    for (const owner of owners) {
      field(owner, 'name', NS.itunes);
      if (!email(field(owner, 'email', NS.itunes))) add('OWNER_EMAIL', 'channel/itunes:owner/itunes:email', 'Некорректный email.');
    }
    function artwork(parent: Element, required: boolean, path: string): void {
      const images = select(parent, 'image', NS.itunes);
      if ((required && !images.length) || images.length > 1) add('ITUNES_IMAGE', path, 'Нужен ровно один itunes:image на уровне подкаста и не более одного у эпизода.');
      for (const image of images) { url(image.getAttribute('href') ?? '', `${path}/@href`); empty(image, path); }
    }
    artwork(channel, true, 'channel/itunes:image');
    const rssImages = select(channel, 'image');
    if (rssImages.length > 1) add('RSS_CARDINALITY', 'channel/image', 'Допускается один image.');
    for (const image of rssImages) {
      paths.set(image, 'channel/image');
      structure(image, ['url', 'title', 'link', 'width', 'height', 'description'], 'channel/image');
      field(image, 'title'); url(field(image, 'url'), 'channel/image/url'); url(field(image, 'link'), 'channel/image/link');
    }
    const cats = select(channel, 'category', NS.itunes);
    if (!cats.length) add('ITUNES_CATEGORY', 'channel/itunes:category', 'Нужна хотя бы одна категория Apple Podcasts.');
    if (cats.length > 2) add('ITUNES_CATEGORY_COUNT', 'channel/itunes:category', 'Apple использует до двух категорий.', 'warning');
    for (const cat of cats) {
      const name = cat.getAttribute('text') ?? '';
      if (!Object.hasOwn(categories, name)) add('ITUNES_CATEGORY', 'channel/itunes:category', `Неизвестная категория «${name}»; регистр важен.`);
      for (const sub of select(cat, 'category', NS.itunes)) {
        if (!(Object.hasOwn(categories, name) && categories[name]!.includes(sub.getAttribute('text') ?? '')) || select(sub, 'category', NS.itunes).length) add('ITUNES_SUBCATEGORY', 'channel/itunes:category', `Неверная подкатегория для «${name}» или глубина вложенности.`);
      }
    }
    for (const name of ['pubDate', 'lastBuildDate']) {
      const date = field(channel, name, '', false);
      if (date && !rssDate(date)) add('RSS_DATE', `channel/${name}`, 'Нужна корректная дата RFC 2822 с часовым поясом.');
    }
    const selfLinks = select(channel, 'link', NS.atom).filter(el => el.getAttribute('rel') === 'self');
    if (!selfLinks.length) add('ATOM_SELF', 'channel/atom:link', 'Рекомендуется atom:link rel=self с постоянным URL фида.', 'warning');
    if (selfLinks.length > 1) add('ATOM_SELF', 'channel/atom:link', 'Допускается один адрес rel=self.');
    for (const self of selfLinks) { url(self.getAttribute('href') ?? '', 'channel/atom:link/@href'); if (self.getAttribute('type') !== 'application/rss+xml') add('ATOM_TYPE', 'channel/atom:link/@type', 'Ожидается application/rss+xml.'); }
    const items = select(channel, 'item');
    episodes = items.length;
    if (!episodes) add('RSS_EPISODES', 'channel', 'Для публикации на платформах нужен хотя бы один эпизод.');
    const guids = new Set<string>(); const urls = new Set<string>();
    const live = children(channel).filter(el => isPodcast(el.namespaceURI) && el.localName === 'liveItem');
    for (const [index, item] of [...items, ...live].entries()) {
      const isLive = isPodcast(item.namespaceURI);
      const path = `channel/${isLive ? 'podcast:liveItem' : 'item'}[${isLive ? index - items.length + 1 : index + 1}]`;
      paths.set(item, path);
      structure(item, ['title', 'link', 'description', 'author', 'category', 'comments', 'enclosure', 'guid', 'pubDate', 'source'], path);
      field(item, 'title'); field(item, 'description', '', !isLive);
      const guid = field(item, 'guid');
      if (guids.has(guid)) add('DUPLICATE_GUID', `${path}/guid`, 'GUID уже встречается в фиде.');
      guids.add(guid);
      const guidElement = select(item, 'guid')[0];
      const perma = guidElement?.getAttribute('isPermaLink');
      if (guidElement?.hasAttribute('isPermaLink') && !['true', 'false'].includes(perma ?? '')) add('GUID_PERMALINK', `${path}/guid`, 'isPermaLink должен быть true или false.');
      if ((!perma || perma === 'true') && !httpsUrl(guid.replace(/^http:\/\//i, 'https://'))) add('GUID_PERMALINK', `${path}/guid`, 'Для непривязанного к HTTP(S) URL GUID укажите isPermaLink=false.');
      const enclosure = select(item, 'enclosure');
      if ((!isLive && enclosure.length !== 1) || enclosure.length > 1) add('RSS_ENCLOSURE', `${path}/enclosure`, 'Нужен ровно один enclosure у каждого эпизода.');
      for (const media of enclosure) {
        empty(media, `${path}/enclosure`);
        const audioUrl = media.getAttribute('url') ?? '';
        url(audioUrl, `${path}/enclosure/@url`);
        if (!isLive) {
          // Normalize harmless URL differences when detecting duplicate enclosures.
          let canonical = audioUrl;
          try { canonical = new URL(audioUrl).href; } catch { /* URL issue already reported. */ }
          if (urls.has(canonical)) add('DUPLICATE_ENCLOSURE', `${path}/enclosure`, 'URL аудио уже встречается в фиде.');
          urls.add(canonical);
        }
        const length = media.getAttribute('length') ?? '';
        if (!integer(length) || (!isLive && Number(length) < 1)) add('ENCLOSURE_LENGTH', `${path}/enclosure/@length`, 'Укажите фактический размер файла в байтах, целое число больше нуля.');
        const mediaType = media.getAttribute('type') ?? '';
        if (!mime(mediaType)) add('ENCLOSURE_TYPE', `${path}/enclosure/@type`, 'Обязателен корректный MIME-тип.');
        else if (!isLive && !['audio/mpeg', 'audio/mp4', 'audio/x-m4a'].includes(mediaType)) add('ENCLOSURE_TYPE', `${path}/enclosure/@type`, 'Для совместимости платформ основной файл должен быть MP3 (audio/mpeg) или AAC в MP4 (audio/mp4). Другие форматы задавайте через alternateEnclosure.');
      }
      const date = field(item, 'pubDate', '', !isLive);
      if (date && !rssDate(date)) add('RSS_DATE', `${path}/pubDate`, 'Нужна корректная дата RFC 2822 с часовым поясом.');
      if (date && Date.parse(date) > Date.now()) add('RSS_FUTURE', `${path}/pubDate`, 'Дата в будущем; RSS сам по себе не обеспечивает отложенную публикацию.', 'warning');
      const explicit = field(item, 'explicit', NS.itunes, false);
      if (explicit && !['true', 'false'].includes(explicit)) add('ITUNES_EXPLICIT', `${path}/itunes:explicit`, 'Допускается true или false.');
      if (explicit === 'true' && channelExplicit === 'false') add('ITUNES_EXPLICIT_CONFLICT', path, 'Explicit-эпизод требует explicit=true на уровне подкаста.');
      const duration = field(item, 'duration', NS.itunes, false);
      if (duration && !/^\d+(?::[0-5]?\d){0,2}$/.test(duration)) add('ITUNES_DURATION', `${path}/itunes:duration`, 'Ожидаются секунды, MM:SS или HH:MM:SS.');
      if (!duration && !isLive) add('ITUNES_DURATION_MISSING', `${path}/itunes:duration`, 'Рекомендуется указать длительность; медиа не анализируется.', 'warning');
      const episodeType = field(item, 'episodeType', NS.itunes, false);
      if (episodeType && !['full', 'trailer', 'bonus'].includes(episodeType)) add('ITUNES_EPISODE_TYPE', path, 'episodeType: full, trailer или bonus.');
      for (const name of ['episode', 'season']) {
        const value = field(item, name, NS.itunes, name === 'episode' && type === 'serial' && (!episodeType || episodeType === 'full') && !isLive);
        if (value && (!integer(value) || Number(value) < 1)) add('ITUNES_NUMBER', `${path}/itunes:${name}`, 'Ожидается положительное целое число.');
      }
      const link = field(item, 'link', '', false); if (link) url(link, `${path}/link`);
      artwork(item, false, `${path}/itunes:image`);
    }
    for (const block of select(channel, 'block', NS.podcast)) if (block.textContent?.trim() === 'yes') add('PLATFORM_BLOCKED', 'channel/podcast:block', 'Фид запрещает импорт всем или выбранной платформе; проверьте намерение.', 'warning');
    if (textOf(channel, 'block', NS.itunes).toLowerCase() === 'yes') add('PLATFORM_BLOCKED', 'channel/itunes:block', 'Фид блокирует Apple Podcasts.', 'warning');
    issues.push(...validatePodcastTree(root));
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    add(e.code, '/', e.message);
  }
  const errors = issues.filter(i => i.severity === 'error').length;
  return { valid: errors === 0, errors, warnings: issues.length - errors, episodes, issues, scope: 'local', unchecked: ['Доступность RSS и медиа, HTTP HEAD/Range', 'Реальный размер, кодек и длительность аудио', 'Формат, размеры и цветовое пространство обложек', 'Содержимое внешних глав/транскриптов, подписи и платёжные адреса', 'Права на контент, аккаунты, региональная доступность и модерация платформ'] };
}
