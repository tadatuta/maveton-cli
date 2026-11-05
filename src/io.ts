import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { constants } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError, httpsUrl, FEED_LIMIT } from './core.ts';

export { FEED_LIMIT } from './core.ts';
export const INPUT_LIMIT = 2 * 1024 * 1024;
function decode(data: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { throw new CliError('UTF8', 'Входной файл должен быть в UTF-8.'); }
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
}
async function readOpened(file: FileHandle, limit: number): Promise<{ data: Buffer; stat: BigIntStats }> {
  const stat = await file.stat({ bigint: true });
  if (!stat.isFile()) throw new CliError('INPUT_FILE', 'Ожидается обычный файл.');
  if (stat.size > BigInt(limit)) throw new CliError('INPUT_SIZE', `Файл превышает лимит ${limit} байт.`);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of file.createReadStream({ autoClose: false })) {
    const data = chunk as Buffer; size += data.length;
    if (size > limit) throw new CliError('INPUT_SIZE', `Файл превышает лимит ${limit} байт.`);
    chunks.push(data);
  }
  if (BigInt(size) !== stat.size || !unchanged(stat, await file.stat({ bigint: true }))) throw new CliError('INPUT_CHANGED', 'Файл изменился во время чтения. Повторите команду.');
  return { data: Buffer.concat(chunks), stat };
}
async function snapshot(path: string, limit: number, noFollow = false): Promise<{ data: Buffer; stat: BigIntStats }> {
  // O_NONBLOCK prevents a FIFO from hanging before we can reject non-regular files.
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
  try {
    return await readOpened(file, limit);
  } finally { await file.close(); }
}
export async function readLocal(path: string, limit = INPUT_LIMIT): Promise<string> {
  return decode((await snapshot(path, limit)).data);
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
  try { await fs.lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
interface WriteOptions {
  overwrite?: boolean;
  sourceSnapshot?: { path: string; content: string };
  protectedPaths?: string[];
}
export async function writeAtomic(path: string, data: string, options: WriteOptions = {}): Promise<{ output: string; backup?: string }> {
  if (Buffer.byteLength(data, 'utf8') > FEED_LIMIT) throw new CliError('FEED_SIZE', 'Результат превышает лимит 20 MiB.', 1);
  const output = `${await fs.realpath(dirname(resolve(path)))}/${basename(path)}`;
  const lockPath = `${output}.maveton.lock`;
  const temp = `${dirname(output)}/.${basename(output)}.${randomUUID()}.tmp`;
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('OUTPUT_LOCKED', `Файл занят другим процессом: ${lockPath}. После аварии удалите lock вручную, убедившись, что процесс завершён.`);
    throw e;
  }
  let backup: string | undefined;
  let tempCreated = false;
  let committed = false;
  let cleanupFailed: boolean;
  let directory: FileHandle | undefined;
  try {
    await lock.writeFile(`${process.pid}\n`);
    const stat = await fs.lstat(output, { bigint: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new CliError('OUTPUT_TYPE', 'Запись в symlink или специальный файл запрещена.');
    if (stat && !options.overwrite) throw new CliError('OUTPUT_EXISTS', `Файл уже существует: ${output}. Для резервной копии и перезаписи добавьте --overwrite.`);
    const checkInputs = async (): Promise<void> => {
      for (const input of options.protectedPaths ?? []) if (await sameFile(input, output)) throw new CliError('OUTPUT_INPUT', 'Выходной RSS не может перезаписать входное описание.');
      if (options.sourceSnapshot && (await readLocal(options.sourceSnapshot.path, FEED_LIMIT)) !== options.sourceSnapshot.content) throw new CliError('SOURCE_CHANGED', 'Исходный RSS изменился после чтения. Повторите команду с актуальным фидом.');
    };
    await checkInputs();
    const original = stat ? await snapshot(output, FEED_LIMIT, true) : undefined;
    if (original && !unchanged(stat!, original.stat)) throw new CliError('OUTPUT_CHANGED', 'Выходной файл изменился перед записью.');
    directory = await fs.open(dirname(output), 'r');
    const file = await fs.open(temp, 'wx', stat ? Number(stat.mode & 0o777n) : 0o644);
    tempCreated = true;
    try {
      await file.writeFile(data, 'utf8');
      if (stat) await file.chmod(Number(stat.mode & 0o777n));
      await file.sync();
    } finally { await file.close(); }
    if (original) {
      backup = `${output}.bak-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
      // Back up the checked descriptor's bytes, never re-open an unchecked path via copyFile.
      const saved = await fs.open(backup, 'wx', Number(original.stat.mode & 0o777n));
      try { await saved.writeFile(original.data); await saved.chmod(Number(original.stat.mode & 0o777n)); await saved.sync(); }
      finally { await saved.close(); }
      await directory.sync();
    }
    await checkInputs();
    if (original) {
      const current = await snapshot(output, FEED_LIMIT, true);
      if (!unchanged(current.stat, original.stat) || !current.data.equals(original.data)) throw new CliError('OUTPUT_CHANGED', 'Выходной файл изменился во время записи; повторите операцию.');
      await fs.rename(temp, output);
    } else {
      // link is atomic and cannot overwrite a file created after the existence check.
      await fs.link(temp, output);
    }
    committed = true;
    await directory.sync();
  } catch (error) {
    if (committed) throw new CliError('OUTPUT_COMMITTED', `RSS уже записан: ${output}. Ошибка синхронизации каталога: ${String(error)}.${backup ? ` Резервная копия: ${backup}.` : ''}`);
    throw error;
  } finally {
    // Attempt every cleanup even if one operation fails; preserve the original failure.
    const cleanup = await Promise.allSettled([
      tempCreated ? fs.unlink(temp).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }) : Promise.resolve(),
      directory?.close(), lock.close(), fs.unlink(lockPath),
    ]);
    cleanupFailed = cleanup.some(r => r.status === 'rejected');
  }
  if (cleanupFailed) throw new CliError(committed ? 'OUTPUT_COMMITTED' : 'OUTPUT_CLEANUP', `${committed ? `RSS записан: ${output}. ` : ''}Не удалось полностью удалить временные файлы или lock.${backup ? ` Резервная копия: ${backup}.` : ''}`);
  return backup ? { output, backup } : { output };
}

export async function sameFile(a: string, b: string): Promise<boolean> {
  if (resolve(a) === resolve(b)) return true;
  try {
    const [aa, bb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return aa.dev === bb.dev && aa.ino === bb.ino;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export const readTemplate = async (name: string): Promise<string> => fs.readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8');
