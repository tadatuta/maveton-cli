import { open, lstat, readFile, rename, unlink, link, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError, httpsUrl } from './core.ts';

export const FEED_LIMIT = 20 * 1024 * 1024;
export const INPUT_LIMIT = 2 * 1024 * 1024;
function decode(data: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new CliError('UTF8', 'Входной файл должен быть в UTF-8.'); }
}
export async function readLocal(path: string, limit = INPUT_LIMIT): Promise<string> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new CliError('INPUT_FILE', 'Ожидается обычный файл.');
    if (stat.size > limit) throw new CliError('INPUT_SIZE', `Файл превышает лимит ${limit} байт.`);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      const data = chunk as Buffer; size += data.length;
      if (size > limit) throw new CliError('INPUT_SIZE', `Файл превышает лимит ${limit} байт.`);
      chunks.push(data);
    }
    return decode(Buffer.concat(chunks));
  } finally { await file.close(); }
}
export async function readFeed(source: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(source)) return readLocal(source, FEED_LIMIT);
  if (!httpsUrl(source)) throw new CliError('FEED_URL', 'Удалённый RSS должен иметь HTTPS URL.');
  const signal = AbortSignal.timeout(30_000);
  let url = source;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(url, { redirect: 'manual', signal, headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'maveton-cli/1.0.0' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new CliError('FEED_REDIRECT', 'Перенаправление без Location.');
      url = new URL(location, url).href;
      if (!httpsUrl(url)) throw new CliError('FEED_REDIRECT', 'Перенаправление на не-HTTPS URL запрещено.');
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new CliError('FEED_HTTP', `Не удалось получить RSS: HTTP ${response.status}.`); }
    if (Number(response.headers.get('content-length')) > FEED_LIMIT) { await response.body?.cancel(); throw new CliError('FEED_SIZE', 'RSS превышает лимит 20 MiB.'); }
    if (!response.body) throw new CliError('FEED_EMPTY', 'Сервер вернул пустой ответ.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > FEED_LIMIT) throw new CliError('FEED_SIZE', 'RSS превышает лимит 20 MiB.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return decode(Buffer.concat(chunks));
  }
  throw new CliError('FEED_REDIRECT', 'Больше пяти перенаправлений RSS.');
}
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
interface WriteOptions {
  overwrite?: boolean;
  sourceSnapshot?: { path: string; content: string };
}
export async function writeAtomic(path: string, data: string, options: WriteOptions = {}): Promise<{ output: string; backup?: string }> {
  const output = resolve(path);
  const lockPath = `${output}.maveton.lock`;
  const temp = `${dirname(output)}/.${basename(output)}.${randomUUID()}.tmp`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('OUTPUT_LOCKED', `Файл занят другим процессом: ${lockPath}. После аварии удалите lock вручную, убедившись, что процесс завершён.`);
    throw e;
  }
  let backup: string | undefined;
  try {
    await lock.writeFile(`${process.pid}\n`);
    const stat = await lstat(output).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new CliError('OUTPUT_TYPE', 'Запись в symlink или специальный файл запрещена.');
    if (stat && !options.overwrite) throw new CliError('OUTPUT_EXISTS', `Файл уже существует: ${output}. Для резервной копии и перезаписи добавьте --overwrite.`);
    if (options.sourceSnapshot && (await readLocal(options.sourceSnapshot.path, FEED_LIMIT)) !== options.sourceSnapshot.content) throw new CliError('SOURCE_CHANGED', 'Исходный RSS изменился после чтения. Повторите команду с актуальным фидом.');
    const file = await open(temp, 'wx', stat ? stat.mode & 0o777 : 0o644);
    try { await file.writeFile(data, 'utf8'); await file.sync(); } finally { await file.close(); }
    if (stat) {
      backup = `${output}.bak-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
      await copyFile(output, backup, constants.COPYFILE_EXCL);
      // Detect an external writer between reading the input and committing the replacement.
      const current = await lstat(output);
      if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || current.size !== stat.size) throw new CliError('OUTPUT_CHANGED', 'Выходной файл изменился во время записи; повторите операцию.');
      await rename(temp, output);
    } else {
      // link is atomic and cannot overwrite a file created after the existence check.
      await link(temp, output);
    }
    const directory = await open(dirname(output), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return backup ? { output, backup } : { output };
  } finally {
    await unlink(temp).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    await lock.close(); await unlink(lockPath);
  }
}

export async function sameFile(a: string, b: string): Promise<boolean> {
  if (resolve(a) === resolve(b)) return true;
  try {
    const [aa, bb] = await Promise.all([lstat(a), lstat(b)]);
    return aa.dev === bb.dev && aa.ino === bb.ino;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export const readTemplate = async (name: string): Promise<string> => readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8');
