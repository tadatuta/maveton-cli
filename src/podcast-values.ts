import { httpsUrl } from './core.ts';

export function geoUri(value: string): boolean {
  const [location, ...parameters] = value.split(';');
  const match = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(-?\d+(?:\.\d+)?))?$/i.exec(location!);
  if (!match || match.slice(1).some(v => v !== undefined && !Number.isFinite(Number(v)))) return false;
  let crs = 'wgs84';
  const seen = new Set<string>();
  for (const [index, parameter] of parameters.entries()) {
    const m = /^([a-z\d-]+)(?:=((?:[a-z\d!$&'()*+\-._~:[\]]|%[a-f\d]{2})+))?$/i.exec(parameter);
    if (!m) return false;
    const name = m[1]!.toLowerCase();
    if (seen.has(name)) return false;
    seen.add(name);
    if (name === 'crs') {
      if (index !== 0 || !/^[a-z\d-]+$/i.test(m[2] ?? '')) return false;
      crs = m[2]!.toLowerCase();
    }
    if (name === 'u' && (index !== (seen.has('crs') ? 1 : 0) || !/^\d+(?:\.\d+)?$/.test(m[2] ?? '') || !Number.isFinite(Number(m[2])))) return false;
  }
  return crs !== 'wgs84' || (Math.abs(Number(match[1])) <= 90 && Math.abs(Number(match[2])) <= 180);
}

export function aspectRatio(value: string): boolean {
  const number = '[+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
  // Literal CSS auto and ratio forms; CSS functions need a style/layout context and are not evaluated.
  let ratio = value.trim();
  if (ratio.toLowerCase() === 'auto') return true;
  if (/^auto\s+/i.test(ratio)) ratio = ratio.replace(/^auto\s+/i, '');
  else ratio = ratio.replace(/\s+auto$/i, '');
  const match = new RegExp(`^(${number})(?:\\s*\\/\\s*(${number}))?$`).exec(ratio);
  return !!match && [match[1]!, match[2] ?? '1'].every(v => Number.isFinite(Number(v)) && Number(v) >= 0);
}

export function sri(value: string): boolean {
  const tokens = value.trim().split(/[ \t\r\n]+/);
  return tokens.length > 0 && tokens.every(token => {
    const m = /^sha(256|384|512)-([A-Za-z\d+/_-]+={0,2})(?:\?[\x21-\x7e]*)?$/.exec(token);
    if (!m) return false;
    const encoded = m[2]!.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = Buffer.from(encoded, 'base64');
    return decoded.length === Number(m[1]) / 8 && (!encoded.includes('=') || encoded.length % 4 === 0) &&
      decoded.toString('base64').replace(/=+$/, '') === encoded.replace(/=+$/, '');
  });
}

// URLs in srcset may themselves contain commas; separators are consumed after the descriptor.
export function imageSources(value: string): boolean {
  let remaining = value.trim();
  const descriptors = new Set<string>();
  let kind: string | undefined;
  let count = 0;
  while (remaining) {
    const match = /^(\S+)\s+(\d+(?:\.\d+)?)(w|x)\s*(,\s*|$)/.exec(remaining);
    if (!match || !httpsUrl(match[1]!) || Number(match[2]) <= 0 || !Number.isFinite(Number(match[2])) || (match[3] === 'w' && !/^\d+$/.test(match[2]!))) return false;
    if (kind && kind !== match[3]) return false;
    kind = match[3];
    const descriptor = String(Number(match[2]));
    if (descriptors.has(descriptor)) return false;
    descriptors.add(descriptor); count++;
    remaining = remaining.slice(match[0].length);
    if (match[4] && !remaining) return false;
  }
  return count > 0;
}
