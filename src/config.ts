import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Either, Option, Try, TryAsync, sequenceValidate, type EitherAsync } from '@ngwes/mini-fp';
import { parse as parseYaml } from 'yaml';
import { all, check, fail, firstProblem, pass, type Checked } from './checked.js';
import { resolveTypescript } from './checks/typescript.js';
import {
  ConfigError,
  type AdapterSettings,
  type Config,
  type CoverageConfig,
  type TypecheckConfig,
} from './types.js';

export const DEFAULT_WITH_SKILL_TEMPLATE = [
  'You have access to the following library. Use its APIs when writing the code.',
  '',
  '--- LIBRARY DOCS ---',
  '{{skill}}',
  '--- END LIBRARY DOCS ---',
  '',
  'Task: {{task}}',
].join('\n');

const KNOWN_KEYS = [
  'skills',
  'evals',
  'model',
  'grader',
  'reps',
  'gradings',
  'concurrency',
  'timeoutSeconds',
  'results',
  'resultFile',
  'withSkillTemplate',
  'graderPrompt',
  'gate',
  'checks',
  'triage',
];

export type ConfigDeps = {
  /** Tells whether `typescript` can be resolved from a project root. Injected by tests. */
  typescriptInstalled?: (root: string) => boolean;
};

/**
 * True when `typescript` resolves from the project, or else from skill-be's own install: the same
 * lookup the presets load it by.
 */
export function typescriptInstalled(root: string): boolean {
  return resolveTypescript(root) !== undefined;
}

/**
 * Reads `skill-be.yaml`, fills the defaults and validates it. Paths in the file resolve against the
 * config file's directory. Throws a `ConfigError` naming the file and the offending key.
 *
 * Every key is checked and every problem collected, in the order of the file's keys; the error
 * names the first one.
 */
export async function loadConfig(configPath: string, deps: ConfigDeps = {}): Promise<Config> {
  const file = path.resolve(configPath);
  const hasTypescript = deps.typescriptInstalled ?? typescriptInstalled;
  const config = await readText(file)
    .bind(parseDocument)
    .bind((document) => firstProblem(buildConfig(document, file, hasTypescript)));
  return config.match(
    (value) => value,
    (message) => {
      throw new ConfigError(`${file}: ${message}`);
    },
  );
}

function readText(file: string): EitherAsync<string, string> {
  return TryAsync.runAsync(() => readFile(file, 'utf8'))
    .toEither()
    .map((text) => text.replace(/^﻿/, ''))
    .mapLeft((error) => `cannot read the config file (${(error as Error).message})`);
}

/** The YAML document; none for an empty file. */
function parseDocument(text: string): Either<string, Option<unknown>> {
  return Try.run(() => Option.from<unknown>(parseYaml(text)))
    .toEither()
    .mapLeft((error) => `invalid YAML: ${(error as Error).message}`);
}

type Mapping = Record<string, unknown>;

/**
 * The config of a document. The structure comes first: the top-level keys and the `checks` and
 * `triage` sections. Then every value, in the order of the config's keys.
 */
function buildConfig(
  document: Option<unknown>,
  configPath: string,
  hasTypescript: (root: string) => boolean,
): Checked<Config> {
  const root = path.dirname(configPath);
  return document
    .match(
      (value) => mapping(value, 'the config'),
      () => pass<Mapping>({}),
    )
    .bind((raw) =>
      all({
        raw: knownKeys(raw, KNOWN_KEYS),
        checks: section(raw.checks, 'checks', ['typecheck', 'coverage']),
        triage: section(raw.triage, 'triage', ['model']),
      }),
    )
    .bind(({ raw, checks, triage }) =>
      all({
        skills: requiredPath(raw.skills, 'skills', root),
        evals: requiredPath(raw.evals, 'evals', root),
        models: parseModels(raw.model),
        grader: parseGrader(raw.grader),
        reps: positiveInteger(raw.reps, 'reps', 3),
        gradings: positiveInteger(raw.gradings, 'gradings', 3),
        concurrency: positiveInteger(raw.concurrency, 'concurrency', 4),
        timeoutSeconds: parseTimeout(raw.timeoutSeconds),
        results: optionalPath(raw.results, 'results', root).map((results) =>
          results.orElse(() => path.join(root, '.skill-be', 'results')),
        ),
        resultFile: optionalPath(raw.resultFile, 'resultFile', root).map((resultFile) =>
          resultFile.orElse(() => path.join(root, 'skill-be.result.json')),
        ),
        withSkillTemplate: parseTemplate(raw.withSkillTemplate),
        graderPrompt: optionalString(raw.graderPrompt, 'graderPrompt'),
        gate: parseGate(raw.gate),
        typecheck: parseTypecheck(checks.typecheck, () => hasTypescript(root)),
        coverage: parseCoverage(checks.coverage),
        triageModel: optional(triage.model, (model) => adapterEntry(model, 'triage.model')),
      }),
    )
    .map(({ graderPrompt, typecheck, coverage, triageModel, ...values }) => ({
      root,
      configPath,
      ...values,
      graderPrompt: graderPrompt.match<string | null>(
        (prompt) => prompt,
        () => null,
      ),
      checks: { typecheck, coverage },
      triage: {
        model: triageModel.match<AdapterSettings | null>(
          (model) => model,
          () => null,
        ),
      },
    }));
}

/**
 * The longest timeout a Node timer holds, 2^31 - 1 ms, in whole seconds (about 24.8 days). Node
 * runs a longer timer after 1 ms, which would time out every call at once.
 */
const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

function parseTimeout(raw: unknown): Checked<number> {
  return positiveNumber(raw, 'timeoutSeconds', 120).bind((seconds) =>
    check(
      seconds <= MAX_TIMEOUT_SECONDS,
      seconds,
      () =>
        `"timeoutSeconds" must be at most ${MAX_TIMEOUT_SECONDS} (about 24.8 days) ` +
        `(got ${seconds})`,
    ),
  );
}

function parseModels(raw: unknown): Checked<AdapterSettings[]> {
  return Option.from(raw).match(
    (value) => {
      if (!Array.isArray(value)) return adapterEntry(value, 'model').map((entry) => [entry]);
      if (value.length === 0) return fail('"model" must not be an empty list');
      return sequenceValidate(value.map((entry, index) => adapterEntry(entry, `model[${index}]`)));
    },
    () => fail('"model" is required'),
  );
}

function parseGrader(raw: unknown): Checked<AdapterSettings> {
  return Option.from(raw).match(
    (value) =>
      Array.isArray(value)
        ? fail('"grader" must be a single entry, not a list')
        : adapterEntry(value, 'grader'),
    () => fail('"grader" is required'),
  );
}

/** An adapter entry keeps every key it has: the adapter's own settings are not ours to judge. */
function adapterEntry(raw: unknown, key: string): Checked<AdapterSettings> {
  return mapping(raw, `"${key}"`, 'with "adapter" and "id"').bind((entry) =>
    all({
      adapter: nonEmptyString(entry.adapter, () => `"${key}.adapter" must be a non-empty string`),
      id: nonEmptyString(entry.id, () => `"${key}.id" must be a non-empty string`),
    }).map(({ adapter, id }) => ({ ...entry, adapter, id })),
  );
}

function parseTemplate(raw: unknown): Checked<string> {
  return optionalString(raw, 'withSkillTemplate')
    .map((template) => template.orElse(DEFAULT_WITH_SKILL_TEMPLATE))
    .bind((template) =>
      sequenceValidate(
        ['{{skill}}', '{{task}}'].map((placeholder) =>
          check(
            template.includes(placeholder),
            placeholder,
            () => `"withSkillTemplate" must contain ${placeholder}`,
          ),
        ),
      ).map(() => template),
    );
}

/**
 * Fails on every key `known` does not list, so a typo such as `bloking: true` cannot fail open.
 * `parent` is the dotted key of the mapping, none for the top level. Adapter entries are not
 * checked: their settings belong to the adapter.
 */
function knownKeys(raw: Mapping, known: readonly string[], parent?: string): Checked<Mapping> {
  return sequenceValidate(
    Object.keys(raw).map((key) =>
      check(known.includes(key), key, () => {
        const name = parent === undefined ? key : `${parent}.${key}`;
        return `unknown key "${name}" (known keys: ${known.join(', ')})`;
      }),
    ),
  ).map(() => raw);
}

/** An optional mapping with only the `known` keys; an empty one when it is absent. */
function section(raw: unknown, key: string, known: readonly string[]): Checked<Mapping> {
  return optional(raw, (value) => mapping(value, `"${key}"`))
    .map((found) => found.orElse({}))
    .bind((found) => knownKeys(found, known, key));
}

function parseGate(raw: unknown): Checked<Config['gate']> {
  return section(raw, 'gate', ['regressionOnCritical', 'blockOnZero', 'blockOnErrors']).bind(
    (gate) =>
      all({
        regressionOnCritical: boolean(gate.regressionOnCritical, 'gate.regressionOnCritical', true),
        blockOnZero: boolean(gate.blockOnZero, 'gate.blockOnZero', true),
        blockOnErrors: boolean(gate.blockOnErrors, 'gate.blockOnErrors', true),
      }),
  );
}

function parseTypecheck(
  raw: unknown,
  hasTypescript: () => boolean,
): Checked<TypecheckConfig | false> {
  return Option.from(raw).match<Checked<TypecheckConfig | false>>(
    (value) => (value === false ? pass(false) : typecheckSettings(value)),
    () => pass(hasTypescript() ? { preset: 'typescript', blocking: true } : false),
  );
}

function typecheckSettings(raw: unknown): Checked<TypecheckConfig | false> {
  const known = ['preset', 'command', 'library', 'blocking', 'preludes'];
  return mapping(raw, '"checks.typecheck"', 'or false')
    .bind((settings) => knownKeys(settings, known, 'checks.typecheck'))
    .bind((settings) => {
      const command = optionalString(settings.command, 'checks.typecheck.command');
      return all({
        command,
        preset: parsePreset(settings.preset, 'checks.typecheck.preset', command),
        library: optionalString(settings.library, 'checks.typecheck.library'),
        preludes: parsePreludes(settings.preludes),
        blocking: boolean(settings.blocking, 'checks.typecheck.blocking', true),
      });
    })
    .map(
      ({ command, preset, library, preludes, blocking }): TypecheckConfig => ({
        blocking,
        ...optionalKey('preset', preset),
        ...optionalKey('command', command),
        ...optionalKey('library', library),
        ...optionalKey('preludes', preludes),
      }),
    );
}

function parseCoverage(raw: unknown): Checked<CoverageConfig | false> {
  if (raw === undefined || raw === null || raw === false) return pass(false);
  const known = ['preset', 'command', 'entry', 'ignore', 'blocking'];
  return mapping(raw, '"checks.coverage"', 'or false')
    .bind((settings) => knownKeys(settings, known, 'checks.coverage'))
    .bind((settings) => {
      const command = optionalString(settings.command, 'checks.coverage.command');
      return all({
        command,
        preset: parsePreset(settings.preset, 'checks.coverage.preset', command),
        entry: optionalString(settings.entry, 'checks.coverage.entry'),
        ignore: stringList(settings.ignore, 'checks.coverage.ignore'),
        blocking: boolean(settings.blocking, 'checks.coverage.blocking', false),
      });
    })
    .map(
      ({ command, preset, entry, ignore, blocking }): CoverageConfig => ({
        ignore,
        blocking,
        ...optionalKey('preset', preset),
        ...optionalKey('command', command),
        ...optionalKey('entry', entry),
      }),
    );
}

/**
 * The TypeScript preset is the only one; with no preset and no command it is implied. A command
 * that fails its own check says nothing about the preset.
 */
function parsePreset(
  raw: unknown,
  key: string,
  command: Checked<Option<string>>,
): Checked<Option<'typescript'>> {
  if (raw === undefined) {
    const implied = command.match((found) => found.isNone(), false);
    return pass(implied ? Option.some('typescript' as const) : Option.none<'typescript'>());
  }
  return check(
    raw === 'typescript',
    Option.some('typescript' as const),
    () => `"${key}" must be "typescript" (got ${show(raw)}); use "command" for another language`,
  );
}

function parsePreludes(raw: unknown): Checked<Option<Record<string, string>>> {
  return optional(raw, (value) =>
    mapping(value, '"checks.typecheck.preludes"').bind((preludes) =>
      all<Record<string, string>>(
        Object.fromEntries(
          Object.entries(preludes).map(([skill, file]) => [
            skill,
            nonEmptyString(
              file,
              () => `"checks.typecheck.preludes.${skill}" must be a non-empty string`,
            ),
          ]),
        ),
      ),
    ),
  );
}

function isRecord(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** `{ [key]: value }` when the option holds a value, else `{}`: a key set only when present. */
function optionalKey<K extends string, T>(key: K, value: Option<T>): { [P in K]?: T } {
  return value.match(
    (found) => ({ [key]: found }) as { [P in K]?: T },
    () => ({}),
  );
}

/** None when the key is absent (missing or `null`), else the checked value. */
function optional<T>(raw: unknown, parse: (value: unknown) => Checked<T>): Checked<Option<T>> {
  return Option.from(raw).match(
    (value) => parse(value).map((parsed) => Option.some(parsed)),
    () => pass(Option.none<T>()),
  );
}

function mapping(raw: unknown, what: string, detail = ''): Checked<Mapping> {
  return check(
    isRecord(raw),
    raw as Mapping,
    () => `${what} must be a mapping${detail ? ` ${detail}` : ''}`,
  );
}

function nonEmptyString(raw: unknown, message: () => string): Checked<string> {
  return check(isNonEmptyString(raw), raw as string, message);
}

function optionalString(raw: unknown, key: string): Checked<Option<string>> {
  return optional(raw, (value) =>
    nonEmptyString(value, () => `"${key}" must be a non-empty string (got ${show(value)})`),
  );
}

function stringList(raw: unknown, key: string): Checked<string[]> {
  return optional(raw, (value) =>
    check(
      Array.isArray(value) && value.every(isNonEmptyString),
      value as string[],
      () => `"${key}" must be a list of non-empty strings`,
    ).map((list) => [...list]),
  ).map((list) => list.orElse([]));
}

function requiredPath(raw: unknown, key: string, root: string): Checked<string> {
  return optionalPath(raw, key, root).bind((resolved) =>
    resolved.match(
      (file) => pass(file),
      () => fail<string>(`"${key}" is required`),
    ),
  );
}

function optionalPath(raw: unknown, key: string, root: string): Checked<Option<string>> {
  return optionalString(raw, key).map((value) => value.map((file) => path.resolve(root, file)));
}

function boolean(raw: unknown, key: string, fallback: boolean): Checked<boolean> {
  if (raw === undefined) return pass(fallback);
  return check(
    typeof raw === 'boolean',
    raw as boolean,
    () => `"${key}" must be true or false (got ${show(raw)})`,
  );
}

function positiveInteger(raw: unknown, key: string, fallback: number): Checked<number> {
  if (raw === undefined) return pass(fallback);
  return check(
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 1,
    raw as number,
    () => `"${key}" must be a positive integer (got ${show(raw)})`,
  );
}

function positiveNumber(raw: unknown, key: string, fallback: number): Checked<number> {
  if (raw === undefined) return pass(fallback);
  return check(
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0,
    raw as number,
    () => `"${key}" must be a positive number (got ${show(raw)})`,
  );
}
