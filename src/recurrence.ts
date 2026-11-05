import { calendarDate, isoDate, integer } from './core.ts';

type DateKind = 'date' | 'utc' | 'local' | 'offset';
function dateKind(value: string): DateKind | undefined {
  const compact = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(value);
  if (compact) {
    if (!calendarDate(Number(compact[1]), Number(compact[2]), Number(compact[3]))) return;
    if (!compact[4]) return 'date';
    if (Number(compact[4]) > 23 || Number(compact[5]) > 59 || Number(compact[6]) > 60) return;
    return compact[7] ? 'utc' : 'local';
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && isoDate(`${value}T00:00:00Z`)) return 'date';
  if (isoDate(value)) return value.endsWith('Z') ? 'utc' : 'offset';
  return;
}

// RFC 5545 §3.3.10, with extended ISO UNTIL dates used in the Podcasting 2.0 examples.
// This checks syntax and cross-field constraints; it never expands a recurrence.
export function recurrenceErrors(rule: string, start: string): string[] {
  const parts = rule.toUpperCase().split(';').map(p => p.split('='));
  const map: Record<string, string | undefined> = Object.fromEntries(parts);
  const errors: string[] = [];
  const numericList = (s: string, max: number, zero: boolean, signed = false): boolean => s.split(',').every(v =>
    (signed ? /^[+-]?\d+$/ : /^\d+$/).test(v) && Math.abs(Number(v)) <= max && (zero || Number(v) !== 0));
  const positive = (s: string): boolean => integer(s) && Number(s) > 0 && Number(s) <= 2147483647;
  const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const checks: Record<string, (s: string) => boolean> = {
    FREQ: s => ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(s),
    COUNT: positive, INTERVAL: positive,
    UNTIL: s => { const kind = dateKind(s); return !!kind && kind !== 'offset'; },
    BYSECOND: s => numericList(s, 60, true), BYMINUTE: s => numericList(s, 59, true), BYHOUR: s => numericList(s, 23, true),
    BYDAY: s => s.split(',').every(v => {
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(v);
      return !!m && (!m[1] || (Number(m[1]) !== 0 && Math.abs(Number(m[1])) <= 53));
    }),
    BYMONTHDAY: s => numericList(s, 31, false, true), BYYEARDAY: s => numericList(s, 366, false, true), BYWEEKNO: s => numericList(s, 53, false, true),
    BYMONTH: s => numericList(s, 12, false), BYSETPOS: s => numericList(s, 366, false, true), WKST: s => days.includes(s),
  };
  if (parts.some(p => p.length !== 2 || !Object.hasOwn(checks, p[0]!) || !checks[p[0]!]!(p[1]!)) || Object.keys(map).length !== parts.length || !map.FREQ) errors.push('Некорректные компоненты RRULE.');
  if (map.COUNT && map.UNTIL) errors.push('COUNT и UNTIL взаимоисключающие.');
  if (map.COUNT && !start) errors.push('RRULE с COUNT требует dtstart.');
  if (map.UNTIL && start) {
    const untilKind = dateKind(map.UNTIL);
    const startKind = dateKind(start);
    if ((untilKind === 'date') !== (startKind === 'date')) errors.push('dtstart и UNTIL должны использовать один тип: date или datetime.');
    if ((startKind === 'utc' || startKind === 'offset') && untilKind !== 'utc') errors.push('Для dtstart с часовым поясом UNTIL должен быть в UTC (Z).');
  }
  if (dateKind(start) === 'date' && ['BYHOUR', 'BYMINUTE', 'BYSECOND'].some(k => map[k])) errors.push('Для dtstart типа date недопустимы BYHOUR/BYMINUTE/BYSECOND.');
  if (map.BYSETPOS && !Object.keys(map).some(k => k.startsWith('BY') && k !== 'BYSETPOS')) errors.push('BYSETPOS требует другого компонента BY*.');
  if (map.BYWEEKNO && map.FREQ !== 'YEARLY') errors.push('BYWEEKNO применим только к YEARLY.');
  if (map.BYMONTHDAY && map.FREQ === 'WEEKLY') errors.push('BYMONTHDAY неприменим к WEEKLY.');
  if (map.BYYEARDAY && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(map.FREQ ?? '')) errors.push('BYYEARDAY неприменим к DAILY/WEEKLY/MONTHLY.');
  if (map.BYDAY?.split(',').some(day => /^[+-]?\d/.test(day)) &&
    (!['MONTHLY', 'YEARLY'].includes(map.FREQ ?? '') || (map.FREQ === 'YEARLY' && map.BYWEEKNO))) errors.push('Порядковый BYDAY допустим только в MONTHLY или YEARLY без BYWEEKNO.');
  return errors;
}
