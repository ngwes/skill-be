import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Either, Option, Try, TryAsync } from '@ngwes/mini-fp';
import type { Declaration, Symbol as TsSymbol, TypeChecker } from 'typescript';
import { splitCommandLine } from '../adapters/command.js';
import { valueOrThrow } from '../checked.js';
import { runProcess, type ProcessResult } from '../process.js';
import { ConfigError, type CoverageConfig, type SkillSuite } from '../types.js';
import {
  compilerOptions,
  createHost,
  libraryExports,
  loadTypescript,
  resolveEntry,
  toTsPath,
  type TypeScript,
  type TypescriptDeps,
} from './typescript.js';

export type CoverageResult = {
  /** The API names that no SKILL.md and no eval file mentions, sorted. */
  missing: string[];
  /** Whether a name in `missing` blocks `verify`. */
  blocking: boolean;
};

export type CoverageDeps = TypescriptDeps;

/** An API name, and the word that has to appear in a skill or an eval for the name to count. */
type ApiName = { name: string; word: string };

/** How long the coverage command may take. */
const COMMAND_TIMEOUT_MS = 60_000;

const ENTRY = 'the coverage entry';

/**
 * Lists the library's public API and reports every name that no `SKILL.md` and no eval file of
 * the suites mentions as a whole word. With `cfg.command`, the API is what the command prints,
 * one name per line, each matched as printed; otherwise the TypeScript preset reads the exports
 * of `cfg.entry` and the public members of exported classes, named `Class.member` and matched by
 * the member name. Paths in `cfg` are relative to `root`.
 */
export async function coverage(
  suites: SkillSuite[],
  cfg: CoverageConfig,
  root: string,
  deps: CoverageDeps = {},
): Promise<CoverageResult> {
  const api = await Option.from(cfg.command).matchAsync(
    (command) => commandApi(command, root),
    () => typescriptApi(cfg, root, deps),
  );
  const ignored = new Set(cfg.ignore);
  const text = (await Promise.all(suites.map(mentionableText))).flat().join('\n');

  const missing = new Set<string>();
  for (const { name, word } of api) {
    if (!ignored.has(name) && !mentions(text, word)) missing.add(name);
  }
  return { missing: [...missing].sort(), blocking: cfg.blocking };
}

/**
 * Checks the coverage settings without listing the API, so that a run can stop before its first
 * model call: the command line splits into a command, or the preset has an entry, finds
 * `typescript` and loads the entry's exports. The command is not started.
 *
 * @throws ConfigError naming the setting that is wrong.
 */
export async function validateCoverage(
  cfg: CoverageConfig,
  root: string,
  deps: CoverageDeps = {},
): Promise<void> {
  await Option.from(cfg.command).matchAsync(
    (command) => void commandWords(command),
    async () => void (await entryExports(cfg, root, deps)),
  );
}

/** The command and its arguments, from `checks.coverage.command`. */
function commandWords(command: string): [string, ...string[]] {
  const [first, ...args] = splitCommandLine(command, '"checks.coverage.command"');
  const bin = valueOrThrow(
    Option.from(first)
      .filter((word) => word !== '')
      .toEither(() => `"checks.coverage.command" has no command: ${command}`),
  );
  return [bin, ...args];
}

/** The symbols `cfg.entry` exports, with the compiler and checker that read them. */
async function entryExports(
  cfg: CoverageConfig,
  root: string,
  deps: CoverageDeps,
): Promise<{ ts: TypeScript; checker: TypeChecker; symbols: TsSymbol[] }> {
  const entry = valueOrThrow(
    Option.from(cfg.entry).toEither(
      () =>
        'the typescript coverage preset needs "checks.coverage.entry", the source entry file of ' +
        'the library; or set "checks.coverage.command" to list the API with a command',
    ),
  );
  const ts = await loadTypescript('coverage', root, deps);
  const library = resolveEntry(entry, root, ENTRY);
  const options = compilerOptions(ts);
  const host = createHost(ts, options, Option.some(library));
  const virtualDir = toTsPath(path.join(path.resolve(root), '.skill-be-coverage'));
  return { ts, ...libraryExports(ts, host, options, library, virtualDir, ENTRY) };
}

/** The names the command prints, one per line. */
async function commandApi(command: string, root: string): Promise<ApiName[]> {
  const [bin, ...args] = commandWords(command);

  const started = await TryAsync.runAsync(() =>
    runProcess({ bin, args, stdin: '', timeoutMs: COMMAND_TIMEOUT_MS, cwd: root }),
  ).onFail((error) => {
    throw new ConfigError(`the coverage command failed to start (${(error as Error).message})`);
  });
  const result = valueOrThrow(
    Either.right<string, ProcessResult>(started).guardBind<ProcessResult>(
      (finished) => Either.right<string, ProcessResult>(finished),
      [
        (finished) => finished.timedOut,
        () => Either.left(`the coverage command timed out after ${COMMAND_TIMEOUT_MS / 1000} s`),
      ],
      [
        (finished) => finished.code !== 0,
        (finished) => {
          const output = (finished.stderr.trim() || finished.stdout.trim()).slice(-2000);
          return Either.left(
            `the coverage command failed (exit code ${finished.code})` +
              `${output === '' ? '' : `: ${output}`}`,
          );
        },
      ],
    ),
  );
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name !== '')
    .map((name) => ({ name, word: name }));
}

/** The exports of the entry file, and the public members of its exported classes. */
async function typescriptApi(
  cfg: CoverageConfig,
  root: string,
  deps: CoverageDeps,
): Promise<ApiName[]> {
  const { ts, checker, symbols } = await entryExports(cfg, root, deps);

  const api: ApiName[] = [];
  for (const symbol of symbols) {
    api.push({ name: symbol.name, word: symbol.name });
    for (const member of publicMembers(ts, checker, symbol)) {
      api.push({ name: `${symbol.name}.${member}`, word: member });
    }
  }
  return api;
}

/**
 * The names of the public instance and static members of an exported class: properties, methods
 * and accessors, parameter properties included. A constructor, a `private`, `protected` or
 * `#private` member and a member named by a symbol (`[Symbol.iterator]`) are not API names. A
 * member a class inherits is listed under the class that declares it.
 */
function publicMembers(ts: TypeScript, checker: TypeChecker, exported: TsSymbol): string[] {
  const symbol =
    exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  if (!(symbol.flags & ts.SymbolFlags.Class)) return [];

  const members = [...(symbol.members?.values() ?? []), ...(symbol.exports?.values() ?? [])];
  return members
    .filter((member) => !member.name.startsWith('__@'))
    .filter((member) => member.declarations?.some((declaration) => isPublic(ts, declaration)))
    .map((member) => member.name);
}

function isPublic(ts: TypeScript, declaration: Declaration): boolean {
  const isMember =
    ts.isPropertyDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration) ||
    (ts.isParameter(declaration) &&
      ts.isParameterPropertyDeclaration(declaration, declaration.parent));
  if (!isMember) return false;
  const hidden = ts.ModifierFlags.Private | ts.ModifierFlags.Protected;
  return (
    !(ts.getCombinedModifierFlags(declaration) & hidden) &&
    !(declaration.name !== undefined && ts.isPrivateIdentifier(declaration.name))
  );
}

/**
 * The text of a skill that can mention a name: its SKILL.md and the strings of its eval file.
 * The keys of the eval file (`id`, `prompt`) are not text a skill author wrote, and the JSON
 * escapes (`\n`) would glue a name to the letter before it.
 */
async function mentionableText(suite: SkillSuite): Promise<string[]> {
  const evalText = await TryAsync.runAsync(() => readFile(suite.evalPath, 'utf8')).match(
    (text) => text.replace(/^﻿/, ''),
    (error) => {
      throw new ConfigError(`cannot read ${suite.evalPath} (${(error as Error).message})`);
    },
  );
  return Try.run(() => [suite.skillText, ...stringsOf(JSON.parse(evalText))]).onFail([
    suite.skillText,
    evalText,
  ]);
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsOf);
  return [];
}

/** A character that continues an identifier, so a name inside a longer word is not a mention. */
const WORD_CHAR = '[\\p{L}\\p{N}_$]';

function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`, 'u').test(text);
}
