export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export const NS = {
  podcast: 'https://podcastindex.org/namespace/1.0',
  itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
  content: 'http://purl.org/rss/1.0/modules/content/',
  atom: 'http://www.w3.org/2005/Atom',
};
export const PODCAST_ALIAS = 'https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md';
export const isPodcast = (uri: string | null): boolean => uri === NS.podcast || uri === PODCAST_ALIAS;
export const email = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export const mime = (s: string): boolean => /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(s);
export const integer = (s: string): boolean => /^\d+$/.test(s) && Number.isSafeInteger(Number(s));
export const decimal = (s: string): boolean => /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) && Number.isFinite(Number(s));
export const uuid5 = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
export function language(s: string): boolean {
  try { return Intl.getCanonicalLocales(s).length === 1; } catch { return false; }
}
export function httpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return /^https:\/\//.test(s) && [...s].every(c => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127) &&
      !/%(?![\da-f]{2})/i.test(s) && !u.username && !u.password && !!u.hostname;
  } catch { return false; }
}
export function uri(s: string): boolean {
  return /^[a-z][a-z\d+.-]*:[^\s]+$/i.test(s) && (!/^https?:/i.test(s) || httpsUrl(s));
}
export function isoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(s);
  if (!m) return false;
  const [, y, mo, d, h, min, sec, tz] = m;
  const days = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  return Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= days &&
    Number(h) < 24 && Number(min) < 60 && Number(sec) < 60 &&
    (tz === 'Z' || (Number(tz?.slice(1, 3)) <= 23 && Number(tz?.slice(-2)) <= 59)) &&
    Number.isFinite(Date.parse(s));
}
export function rssDate(s: string): boolean {
  const m = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|UT|UTC|GMT|[ECMP][SD]T)$/.exec(s);
  if (!m || !Number.isFinite(Date.parse(s))) return false;
  const [, day, d, month, y, h, min, sec, tz] = m;
  const mi = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ').indexOf(month!);
  const date = new Date(Date.UTC(Number(y), mi, Number(d)));
  return date.getUTCMonth() === mi && Number(d) >= 1 && Number(h) < 24 && Number(min) < 60 && Number(sec ?? 0) < 60 &&
    (!/^[+-]/.test(tz!) || (Number(tz!.slice(1, 3)) < 24 && Number(tz!.slice(3)) < 60)) &&
    (!day || day === ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()]);
}
export const toRssDate = (s: string | Date): string => new Date(s).toUTCString().replace('GMT', '+0000');

export function xmlChars(s: string): boolean {
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) return false;
  }
  return true;
}

export function object(value: unknown, path: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('INPUT_TYPE', `${path}: ожидается объект.`);
  const record = value as Record<string, unknown>;
  if (keys) for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new CliError('INPUT_FIELD', `${path}.${key}: неизвестное поле.`);
  }
  return record;
}
export function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || !xmlChars(value)) throw new CliError('INPUT_TYPE', `${path}: ожидается непустая строка с допустимыми символами XML.`);
  return value;
}
