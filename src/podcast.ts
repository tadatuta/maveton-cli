import { NS, isPodcast, httpsUrl, uri, email, mime, decimal, integer, uuid5, language, isoDate, rssDate } from './core.ts';
import type { Issue } from './core.ts';
import { children, select } from './xml.ts';
import type { Element } from './xml.ts';
import { specData } from './spec-data.ts';
import { recurrenceErrors } from './recurrence.ts';
import { geoUri, aspectRatio, sri, imageSources } from './podcast-values.ts';

type Check = (value: string) => boolean;
interface Rule {
  parents: string[];
  single?: boolean;
  required?: string[];
  attrs?: Record<string, Check>;
  text?: Check;
  maxText?: number;
  children?: string[];
  minChildren?: Record<string, number>;
}
const any: Check = s => !!s.trim();
const bool: Check = s => s === 'true' || s === 'false';
const yesno: Check = s => s === 'yes' || s === 'no';
const positive: Check = s => decimal(s) && Number(s) > 0;
const posInt: Check = s => integer(s) && Number(s) > 0;
const oneOf = (...values: string[]): Check => s => values.includes(s);
const text128: Check = s => !!s.trim();
const mediums = ['podcast', 'music', 'video', 'film', 'audiobook', 'newsletter', 'blog', 'publisher', 'course'];
const medium = oneOf(...mediums, ...mediums.map(m => `${m}L`), 'mixed');
const dateOnly: Check = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && isoDate(`${s}T00:00:00Z`);
const fqdn: Check = s => /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(s);
// All canonized tags, including the deprecated images tag. Item children also work in liveItem.
export const podcastRules: Record<string, Rule> = {
  transcript: { parents: ['item'], required: ['url', 'type'], attrs: { url: httpsUrl, type: mime, language, rel: oneOf('captions') } },
  locked: { parents: ['channel'], single: true, attrs: { owner: email }, text: yesno },
  funding: { parents: ['channel', 'item'], required: ['url'], attrs: { url: httpsUrl }, text: text128, maxText: 128 },
  chapters: { parents: ['item'], single: true, required: ['url', 'type'], attrs: { url: httpsUrl, type: mime } },
  soundbite: { parents: ['item'], required: ['startTime', 'duration'], attrs: { startTime: decimal, duration: positive }, text: () => true, maxText: 128 },
  person: { parents: ['channel', 'item'], attrs: { role: any, group: any, img: httpsUrl, href: httpsUrl }, text: text128, maxText: 128 },
  location: { parents: ['channel', 'item'], attrs: { rel: oneOf('subject', 'creator'), geo: geoUri, osm: s => /^[NWR]\d+$/i.test(s), country: s => /^[A-Z]{2}$/.test(s) }, text: text128, maxText: 128 },
  season: { parents: ['item'], single: true, attrs: { name: any }, text: s => /^-?\d+$/.test(s) && Number.isSafeInteger(Number(s)) },
  episode: { parents: ['item'], single: true, attrs: { display: any }, text: s => /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) && Number.isFinite(Number(s)) },
  trailer: { parents: ['channel'], required: ['url', 'pubdate'], attrs: { url: httpsUrl, pubdate: rssDate, length: integer, type: mime, season: integer }, text: text128, maxText: 128 },
  license: { parents: ['channel', 'item'], single: true, attrs: { url: httpsUrl }, text: text128, maxText: 128 },
  alternateEnclosure: { parents: ['item'], required: ['type'], attrs: { type: mime, length: integer, bitrate: positive, height: posInt, lang: language, title: any, rel: any, codecs: any, default: bool }, children: ['source', 'integrity'], minChildren: { source: 1 } },
  source: { parents: ['alternateEnclosure'], required: ['uri'], attrs: { uri, contentType: mime } },
  integrity: { parents: ['alternateEnclosure'], single: true, required: ['type', 'value'], attrs: { type: oneOf('sri', 'pgp-signature'), value: any } },
  guid: { parents: ['channel'], single: true, text: uuid5 },
  value: { parents: ['channel', 'item'], required: ['type', 'method'], attrs: { type: any, method: any, suggested: decimal }, children: ['valueRecipient', 'valueTimeSplit'], minChildren: { valueRecipient: 1 } },
  valueRecipient: { parents: ['value', 'valueTimeSplit'], required: ['type', 'address', 'split'], attrs: { type: any, address: any, split: integer, name: any, customKey: any, customValue: any, fee: bool } },
  medium: { parents: ['channel'], single: true, text: medium },
  liveItem: { parents: ['channel'], required: ['status', 'start'], attrs: { status: oneOf('pending', 'live', 'ended'), start: isoDate, end: isoDate }, children: ['*'], minChildren: { contentLink: 1 } },
  contentLink: { parents: ['item'], required: ['href'], attrs: { href: uri }, text: () => true },
  socialInteract: { parents: ['channel', 'item'], required: ['protocol'], attrs: { protocol: any, uri, accountId: any, accountUrl: httpsUrl, priority: integer } },
  block: { parents: ['channel'], attrs: { id: any }, text: yesno },
  txt: { parents: ['channel', 'item'], attrs: { purpose: any }, text: () => true, maxText: 4000 },
  remoteItem: { parents: ['channel', 'podroll', 'valueTimeSplit', 'publisher'], required: ['feedGuid'], attrs: { feedGuid: uuid5, feedUrl: httpsUrl, itemGuid: any, medium, title: any } },
  podroll: { parents: ['channel'], single: true, children: ['remoteItem'], minChildren: { remoteItem: 1 } },
  updateFrequency: { parents: ['channel'], single: true, attrs: { complete: bool, dtstart: s => isoDate(s) || dateOnly(s), rrule: any }, text: () => true, maxText: 128 },
  podping: { parents: ['channel'], single: true, required: ['usesPodping'], attrs: { usesPodping: bool } },
  valueTimeSplit: { parents: ['value'], required: ['startTime', 'duration'], attrs: { startTime: decimal, duration: positive, remoteStartTime: decimal, remotePercentage: s => /^-?\d+(?:\.\d+)?$/.test(s) }, children: ['remoteItem', 'valueRecipient'] },
  chat: { parents: ['channel', 'item'], single: true, required: ['server', 'protocol'], attrs: { server: fqdn, protocol: any, accountId: any, space: any } },
  publisher: { parents: ['channel'], single: true, children: ['remoteItem'], minChildren: { remoteItem: 1 } },
  image: { parents: ['channel', 'item'], required: ['href'], attrs: { href: httpsUrl, alt: () => true, 'aspect-ratio': aspectRatio, width: posInt, height: posInt, type: mime, purpose: any } },
  images: { parents: ['channel', 'item'], single: true, required: ['srcset'], attrs: { srcset: imageSources } },
};

export function validatePodcastTree(root: Element): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, path: string, message: string, severity: Issue['severity'] = 'error'): void => { issues.push({ code, path, message, severity }); };
  function visit(parent: Element, path: string): void {
    const counts = new Map<string, number>();
    for (const el of children(parent)) {
      const key = `${el.namespaceURI}:${el.localName}`;
      const index = (counts.get(key) ?? 0) + 1; counts.set(key, index);
      const p = `${path}/${el.tagName}[${index}]`;
      if (isPodcast(el.namespaceURI)) {
        const name = el.localName!;
        const rule = Object.hasOwn(podcastRules, name) ? podcastRules[name] : undefined;
        if (!rule) { add('PODCAST_UNKNOWN_TAG', p, 'Тег отсутствует в зафиксированной спецификации Podcasting 2.0.', 'warning'); visit(el, p); continue; }
        const allowedParent = rule.parents.some(name => name === 'channel' || name === 'item'
          ? (!parent.namespaceURI && parent.localName === name) || (name === 'item' && isPodcast(parent.namespaceURI) && parent.localName === 'liveItem')
          : isPodcast(parent.namespaceURI) && parent.localName === name);
        if (!allowedParent) add('PODCAST_PARENT', p, `Допустимые родители: ${rule.parents.join(', ')}; namespace родителя также должен совпадать.`);
        if (rule.single && select(parent, name, NS.podcast).length > 1 && index === 1) add('PODCAST_COUNT', p, 'Допускается только один такой тег у родителя.');
        for (const attr of rule.required ?? []) if (!el.getAttribute(attr)?.trim()) add('PODCAST_ATTRIBUTE_REQUIRED', `${p}/@${attr}`, 'Обязательный атрибут отсутствует или пуст.');
        for (const attr of Array.from(el.attributes)) {
          if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
          const check = rule.attrs && Object.hasOwn(rule.attrs, attr.name) ? rule.attrs[attr.name] : undefined;
          if (!check) add('PODCAST_UNKNOWN_ATTRIBUTE', `${p}/@${attr.name}`, 'Атрибут отсутствует в спецификации.', 'warning');
          else if (!check(attr.value)) add('PODCAST_ATTRIBUTE', `${p}/@${attr.name}`, `Недопустимое значение атрибута ${attr.name}.`);
        }
        const value = Array.from(el.childNodes).filter(n => n.nodeType === 3 || n.nodeType === 4).map(n => n.nodeValue).join('').trim();
        if (rule.text && !rule.text(value)) add('PODCAST_TEXT', p, 'Недопустимое или пустое текстовое значение.');
        if (!rule.text && value) add('PODCAST_TEXT', p, 'Этот тег не должен содержать текст.');
        if (rule.maxText && [...value].length > rule.maxText) add('PODCAST_TEXT_LENGTH', p, `Рекомендуемая длина — не более ${rule.maxText} символов.`, 'warning');
        for (const child of children(el)) {
          if (!rule.children?.includes('*') && (!isPodcast(child.namespaceURI) || !rule.children?.includes(child.localName!))) add('PODCAST_CHILD', p, `Недопустимый дочерний тег ${child.tagName}.`);
        }
        for (const [child, minimum] of Object.entries(rule.minChildren ?? {})) if (select(el, child, NS.podcast).length < minimum) add('PODCAST_CHILD_REQUIRED', p, `Нужен дочерний podcast:${child}.`);
        const a = (key: string): string => el.getAttribute(key) ?? '';
        if (name === 'socialInteract') {
          if (a('protocol') === 'disabled') {
            if (Array.from(el.attributes).some(at => at.name !== 'protocol' && at.namespaceURI !== 'http://www.w3.org/2000/xmlns/')) add('PODCAST_DISABLED', p, 'При protocol=disabled другие атрибуты запрещены.');
          } else if (!a('uri')) add('PODCAST_ATTRIBUTE_REQUIRED', `${p}/@uri`, 'Нужен URI корневого сообщения.');
          if (!specData.socialProtocols.includes(a('protocol'))) add('PODCAST_REGISTRY', p, 'Протокол отсутствует в зафиксированном реестре.', 'warning');
        }
        if (name === 'license' && !specData.licenses.includes(value.toLowerCase()) && !a('url')) add('PODCAST_LICENSE_URL', p, 'Для пользовательской лицензии нужен url.');
        if (name === 'person') for (const [attr, registry] of [['role', specData.roles], ['group', specData.groups]] as const) if (a(attr) && !registry.includes(a(attr).toLowerCase())) add('PODCAST_TAXONOMY', `${p}/@${attr}`, 'Значение отсутствует в зафиксированной таксономии.', 'warning');
        if (name === 'block' && a('id') && !specData.services.includes(a('id'))) add('PODCAST_REGISTRY', p, 'Сервис отсутствует в зафиксированном реестре.', 'warning');
        if (name === 'chat' && !specData.chatProtocols.includes(a('protocol'))) add('PODCAST_REGISTRY', p, 'Протокол чата отсутствует в зафиксированном реестре.', 'warning');
        if (name === 'publisher') {
          const remote = select(el, 'remoteItem', NS.podcast);
          if (remote.length !== 1 || remote[0]?.getAttribute('medium') !== 'publisher') add('PODCAST_PUBLISHER', p, 'Нужен ровно один remoteItem с medium=publisher.');
        }
        if (name === 'valueTimeSplit') {
          const remote = select(el, 'remoteItem', NS.podcast).length;
          const recipients = select(el, 'valueRecipient', NS.podcast).length;
          if (!((remote === 1 && !recipients) || (!remote && recipients > 0))) add('PODCAST_TIME_SPLIT', p, 'Нужен один remoteItem ИЛИ один/несколько valueRecipient.');
          if (a('remotePercentage') && (Number(a('remotePercentage')) < 0 || Number(a('remotePercentage')) > 100)) add('PODCAST_PERCENTAGE', p, 'Клиенты ограничат remotePercentage диапазоном 0–100.', 'warning');
        }
        if (name === 'valueRecipient') {
          if (!!a('customKey') !== !!a('customValue')) add('PODCAST_CUSTOM_PAIR', p, 'customKey и customValue задаются вместе.');
          if (a('type') === 'node' && !/^(02|03)[0-9a-f]{64}$/i.test(a('address'))) add('PODCAST_NODE', p, 'Ожидается сжатый публичный ключ Lightning (66 hex-символов).');
          if (a('type') === 'lnaddress' && !email(a('address'))) add('PODCAST_LNADDRESS', p, 'Некорректный Lightning Address.');
        }
        if (name === 'value' || name === 'valueTimeSplit') {
          const recipients = select(el, 'valueRecipient', NS.podcast);
          if (recipients.length && recipients.every(r => Number(r.getAttribute('split')) === 0)) add('PODCAST_SPLITS', p, 'Сумма долей должна быть больше нуля.');
        }
        if (name === 'integrity') {
          const valid = a('type') === 'sri' ? sri(a('value')) : /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(a('value'));
          if (!valid) add('PODCAST_INTEGRITY', p, 'Неверный синтаксис SRI/base64 подписи.');
        }
        if (name === 'liveItem') {
          if (a('end') && Date.parse(a('end')) <= Date.parse(a('start'))) add('PODCAST_LIVE_DATE', p, 'end должен быть позже start.');
          for (const required of ['title', 'guid']) if (!select(el, required)[0]?.textContent?.trim()) add('PODCAST_LIVE_REQUIRED', p, `Для liveItem нужен ${required}.`);
          if (!select(el, 'enclosure').length && !select(el, 'alternateEnclosure', NS.podcast).length) add('PODCAST_LIVE_MEDIA', p, 'Нужен enclosure или alternateEnclosure.');
        }
        if (name === 'updateFrequency' && a('rrule')) {
          for (const message of recurrenceErrors(a('rrule'), a('dtstart'))) add(message.includes('dtstart') ? 'PODCAST_RRULE_START' : 'PODCAST_RRULE', p, message);
        }
        if (name === 'images') add('PODCAST_DEPRECATED', p, 'images устарел; используйте image.', 'warning');
        if (name === 'medium' && (value.endsWith('L') || value === 'mixed')) {
          if (select(parent, 'item').length || select(parent, 'liveItem', NS.podcast).length) add('PODCAST_MEDIUM_ITEMS', p, 'List-фид ссылается на удалённые фиды и не должен содержать обычные item/liveItem.');
          if (!select(parent, 'remoteItem', NS.podcast).length) add('PODCAST_MEDIUM_REMOTE', p, 'List-фид требует хотя бы один remoteItem.');
        }
        if (name === 'medium' && value === 'publisher') {
          if (!select(parent, 'guid', NS.podcast).length || !select(parent, 'remoteItem', NS.podcast).length) add('PODCAST_PUBLISHER_REQUIRED', p, 'Publisher-фид требует podcast:guid и хотя бы один remoteItem.');
        }
        if (name === 'txt' && a('purpose') === 'ai-content' && !bool(value)) add('PODCAST_AI_CONTENT', p, 'ai-content должен содержать true или false.');
        const limits: Record<string, Record<string, number>> = { season: { name: 128 }, episode: { display: 32 }, alternateEnclosure: { title: 32, rel: 32 }, txt: { purpose: 128 }, image: { purpose: 128 } };
        for (const [attr, limit] of Object.entries(limits[name] ?? {})) if ([...a(attr)].length > limit) add('PODCAST_ATTRIBUTE_LENGTH', `${p}/@${attr}`, `Рекомендуется не больше ${limit} символов.`, 'warning');
      }
      visit(el, p);
    }
  }
  visit(root, '/rss');
  return issues;
}
