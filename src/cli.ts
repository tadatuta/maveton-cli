#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError } from './core.ts';
import { readLocal, readFeed, writeAtomic, exists, sameFile, readTemplate } from './io.ts';
import { parseInput, podcastInput, episodeInput } from './input.ts';
import { createFeed, addEpisode } from './feed.ts';
import { parseXml, select, channelOf } from './xml.ts';
import { validate } from './validate.ts';
import type { ValidationReport } from './validate.ts';

const HELP = `maveton — создание и локальная проверка RSS подкастов

Использование:
  maveton init [--directory DIR] [--json]
  maveton add --episode FILE (--podcast FILE | --feed FILE_OR_HTTPS_URL) --output FILE
  maveton validate --feed FILE_OR_HTTPS_URL [--strict] [--json]

Команды:
  init      Создать шаблоны podcast.yaml и episode.yaml (не готовый RSS).
  add       Добавить новый выпуск или создать RSS с первым выпуском.
  validate  Проверить XML, RSS, iTunes и Podcasting 2.0 без запросов к медиа.

Опции add:
  --episode FILE   YAML/JSON с описанием эпизода.
  --podcast FILE   YAML/JSON с данными подкаста для нового RSS.
  --feed SOURCE    Существующий локальный RSS или HTTPS URL.
  --output FILE    Выходной RSS; «-» означает stdout.
  --now            Публикация сейчас, вместо publishedAt во входном файле.
  --overwrite      Разрешить перезапись с обязательной резервной копией.
  --dry-run        Выполнить проверки и показать план без записи файлов.
  --strict         Считать предупреждения ошибкой команды; не записывать результат.
  --json           Машиночитаемый отчёт в stdout (несовместим с --output -).

Общие опции:
  --help, -h       Эта справка.
  --version, -v    Версия.

Коды выхода: 0 — успех; 1 — ошибки валидации/дубликат/strict;
             2 — аргументы, входные данные, файловые или сетевые ошибки.
Сеть используется только для чтения RSS по явно переданному HTTPS URL.
`;

function showReport(report: ValidationReport): void {
  for (const i of report.issues) process.stderr.write(`${i.severity === 'error' ? 'ОШИБКА' : 'ПРЕДУПРЕЖДЕНИЕ'} [${i.code}] ${i.path}: ${i.message}\n`);
  process.stderr.write(`Локальная проверка: эпизодов ${report.episodes}, ошибок ${report.errors}, предупреждений ${report.warnings}. Медиа и доступность серверов не проверялись.\n`);
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true, strict: true,
    options: {
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      directory: { type: 'string' }, episode: { type: 'string' }, podcast: { type: 'string' }, feed: { type: 'string' }, output: { type: 'string' },
      now: { type: 'boolean' }, overwrite: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, strict: { type: 'boolean' }, json: { type: 'boolean' },
    },
  });
  const { values: v, positionals } = parsed;
  if (v.help || (!positionals.length && !v.version)) { process.stdout.write(HELP); return; }
  if (v.version) { process.stdout.write('1.0.0\n'); return; }
  const command = positionals[0]!;
  if (positionals.length !== 1 || !['init', 'add', 'validate'].includes(command)) throw new CliError('USAGE', 'Ожидается одна команда init, add или validate. См. --help.');
  const allowed: Record<string, string[]> = {
    init: ['directory', 'json'], validate: ['feed', 'strict', 'json'],
    add: ['episode', 'podcast', 'feed', 'output', 'now', 'overwrite', 'dry-run', 'strict', 'json'],
  };
  for (const key of Object.keys(v)) if (!allowed[command]!.includes(key)) throw new CliError('USAGE', `Опция --${key} не поддерживается командой ${command}.`);
  if (command === 'init') {
    const directory = resolve(v.directory ?? '.');
    const paths = ['podcast.yaml', 'episode.yaml'].map(name => resolve(directory, name));
    for (const path of paths) if (await exists(path)) throw new CliError('OUTPUT_EXISTS', `Шаблон уже существует: ${path}. Используйте другую директорию.`);
    const templates = await Promise.all(['podcast.yaml', 'episode.yaml'].map(readTemplate));
    await mkdir(directory, { recursive: true });
    for (const [index, path] of paths.entries()) await writeAtomic(path, templates[index]!);
    if (v.json) process.stdout.write(JSON.stringify({ ok: true, command, files: paths }) + '\n');
    else process.stderr.write(`Созданы шаблоны:\n${paths.join('\n')}\nЗамените примеры своими данными, затем выполните add.\n`);
    return;
  }
  if (command === 'validate') {
    if (!v.feed) throw new CliError('USAGE', 'Укажите --feed FILE_OR_HTTPS_URL.');
    const report = validate(await readFeed(v.feed));
    const ok = report.valid && !(v.strict && report.warnings);
    if (v.json) process.stdout.write(JSON.stringify({ ok, command, ...report }, null, 2) + '\n');
    else showReport(report);
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (!v.episode || !v.output || Boolean(v.podcast) === Boolean(v.feed)) throw new CliError('USAGE', 'add требует --episode, --output и ровно один источник: --podcast либо --feed.');
  if (v.json && v.output === '-') throw new CliError('USAGE', '--json несовместим с --output -: stdout не может одновременно содержать XML и JSON.');
  if (v.overwrite && v.output === '-') throw new CliError('USAGE', '--overwrite не применяется к stdout.');
  for (const input of [v.episode, v.podcast].filter((p): p is string => !!p)) if (v.output !== '-' && await sameFile(input, v.output)) throw new CliError('OUTPUT_INPUT', 'Выходной RSS не может перезаписать YAML/JSON входного описания.');
  const episode = episodeInput(parseInput(await readLocal(v.episode)), !!v.now);
  const source = v.feed ? await readFeed(v.feed) : undefined;
  const doc = source !== undefined ? parseXml(source) : createFeed(podcastInput(parseInput(await readLocal(v.podcast!))));
  const before = select(channelOf(doc), 'item').length;
  const result = addEpisode(doc, episode);
  const report = validate(result.xml);
  const ok = report.valid && !(v.strict && report.warnings);
  const plan = { output: v.output === '-' ? '-' : resolve(v.output), episodesBefore: before, episodesAfter: report.episodes, guid: result.guid, title: episode.title, explicitChanged: result.explicitChanged };
  let written: { output: string; backup?: string } | undefined;
  if (ok && !v['dry-run'] && v.output !== '-') {
    const options = v.feed && !/^https:\/\//.test(v.feed) && source !== undefined ? { overwrite: !!v.overwrite, sourceSnapshot: { path: v.feed, content: source } } : { overwrite: !!v.overwrite };
    written = await writeAtomic(v.output, result.xml, options);
  }
  if (v.json) process.stdout.write(JSON.stringify({ ok, command, dryRun: !!v['dry-run'], plan, ...(written ? { written } : {}), validation: report }, null, 2) + '\n');
  else {
    showReport(report);
    if (ok) {
      process.stderr.write(`${v['dry-run'] ? 'Предпросмотр' : 'Готово'}: «${episode.title}», GUID ${result.guid}; эпизодов ${before} → ${report.episodes}.\n`);
      if (result.explicitChanged) process.stderr.write('itunes:explicit подкаста изменён на true, поскольку новый выпуск explicit.\n');
      if (written) process.stderr.write(`RSS: ${written.output}\n${written.backup ? `Резервная копия: ${written.backup}\n` : ''}`);
      if (v.output === '-') process.stdout.write(result.xml);
    }
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((error: unknown) => {
  const e = error instanceof CliError ? error : new CliError('OPERATION_FAILED', error instanceof Error ? error.message : String(error));
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: false, error: { code: e.code, message: e.message } }) + '\n');
  else process.stderr.write(`Ошибка [${e.code}]: ${e.message}\n`);
  process.exitCode = e.exitCode;
});
