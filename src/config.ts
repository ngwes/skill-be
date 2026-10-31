import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
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
 */
export async function loadConfig(configPath: string, deps: ConfigDeps = {}): Promise<Config> {
  const file = path.resolve(configPath);
  try {
    const document = parseDocument(await readText(file));
    const hasTypescript = deps.typescriptInstalled ?? typescriptInstalled;
    return buildConfig(document, file, hasTypescript);
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${file}: ${error.message}`);
    throw error;
  }
}

async function readText(file: string): Promise<string> {
  try {
    return (await readFile(file, 'utf8')).replace(/^﻿/, '');
  } catch (error) {
    throw new ConfigError(`cannot read the config file (${(error as Error).message})`);
  }
}

function parseDocument(text: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new ConfigError(`invalid YAML: ${(error as Error).message}`);
  }
}

type Mapping = Record<string, unknown>;

function buildConfig(
  document: unknown,
  configPath: string,
  hasTypescript: (root: string) => boolean,
): Config {
  const root = path.dirname(configPath);
  const raw = document === null || document === undefined ? {} : mapping(document, 'the config');

  onlyKnownKeys(raw, KNOWN_KEYS);
  const checks = optionalMapping(raw.checks, 'checks') ?? {};
  onlyKnownKeys(checks, ['typecheck', 'coverage'], 'checks');
  const triage = optionalMapping(raw.triage, 'triage') ?? {};
  onlyKnownKeys(triage, ['model'], 'triage');

  return {
    root,
    configPath,
    skills: requiredPath(raw.skills, 'skills', root),
    evals: requiredPath(raw.evals, 'evals', root),
    models: parseModels(raw.model),
    grader: parseGrader(raw.grader),
    reps: positiveInteger(raw.reps, 'reps', 3),
    gradings: positiveInteger(raw.gradings, 'gradings', 3),
    concurrency: positiveInteger(raw.concurrency, 'concurrency', 4),
    timeoutSeconds: parseTimeout(raw.timeoutSeconds),
    results: optionalPath(raw.results, 'results', root) ?? path.join(root, '.skill-be', 'results'),
    resultFile:
      optionalPath(raw.resultFile, 'resultFile', root) ?? path.join(root, 'skill-be.result.json'),
    withSkillTemplate: parseTemplate(raw.withSkillTemplate),
    graderPrompt: optionalString(raw.graderPrompt, 'graderPrompt') ?? null,
    gate: parseGate(raw.gate),
    checks: {
      typecheck: parseTypecheck(checks.typecheck, () => hasTypescript(root)),
      coverage: parseCoverage(checks.coverage),
    },
    triage: {
      model:
        triage.model === undefined || triage.model === null
          ? null
          : adapterEntry(triage.model, 'triage.model'),
    },
  };
}

/**
 * The longest timeout a Node timer holds, 2^31 - 1 ms, in whole seconds (about 24.8 days). Node
 * runs a longer timer after 1 ms, which would time out every call at once.
 */
const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

function parseTimeout(raw: unknown): number {
  const seconds = positiveNumber(raw, 'timeoutSeconds', 120);
  if (seconds > MAX_TIMEOUT_SECONDS) {
    throw new ConfigError(
      `"timeoutSeconds" must be at most ${MAX_TIMEOUT_SECONDS} (about 24.8 days) (got ${seconds})`,
    );
  }
  return seconds;
}

function parseModels(raw: unknown): AdapterSettings[] {
  if (raw === undefined || raw === null) throw new ConfigError('"model" is required');
  if (!Array.isArray(raw)) return [adapterEntry(raw, 'model')];
  if (raw.length === 0) throw new ConfigError('"model" must not be an empty list');
  return raw.map((entry, index) => adapterEntry(entry, `model[${index}]`));
}

function parseGrader(raw: unknown): AdapterSettings {
  if (raw === undefined || raw === null) throw new ConfigError('"grader" is required');
  if (Array.isArray(raw)) throw new ConfigError('"grader" must be a single entry, not a list');
  return adapterEntry(raw, 'grader');
}

/** An adapter entry keeps every key it has: the adapter's own settings are not ours to judge. */
function adapterEntry(raw: unknown, key: string): AdapterSettings {
  const entry = mapping(raw, `"${key}"`, 'with "adapter" and "id"');
  const { adapter, id } = entry;
  if (!isNonEmptyString(adapter)) {
    throw new ConfigError(`"${key}.adapter" must be a non-empty string`);
  }
  if (!isNonEmptyString(id)) throw new ConfigError(`"${key}.id" must be a non-empty string`);
  return { ...entry, adapter, id };
}

function parseTemplate(raw: unknown): string {
  const template = optionalString(raw, 'withSkillTemplate') ?? DEFAULT_WITH_SKILL_TEMPLATE;
  for (const placeholder of ['{{skill}}', '{{task}}']) {
    if (!template.includes(placeholder)) {
      throw new ConfigError(`"withSkillTemplate" must contain ${placeholder}`);
    }
  }
  return template;
}

/**
 * Throws on a key `known` does not list, so a typo such as `bloking: true` cannot fail open.
 * `parent` is the dotted key of the mapping, none for the top level. Adapter entries are not
 * checked: their settings belong to the adapter.
 */
function onlyKnownKeys(raw: Mapping, known: readonly string[], parent?: string): void {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) {
      const name = parent === undefined ? key : `${parent}.${key}`;
      throw new ConfigError(`unknown key "${name}" (known keys: ${known.join(', ')})`);
    }
  }
}

function parseGate(raw: unknown): Config['gate'] {
  const gate = optionalMapping(raw, 'gate') ?? {};
  onlyKnownKeys(gate, ['regressionOnCritical', 'blockOnZero', 'blockOnErrors'], 'gate');
  return {
    regressionOnCritical: boolean(gate.regressionOnCritical, 'gate.regressionOnCritical', true),
    blockOnZero: boolean(gate.blockOnZero, 'gate.blockOnZero', true),
    blockOnErrors: boolean(gate.blockOnErrors, 'gate.blockOnErrors', true),
  };
}

function parseTypecheck(raw: unknown, hasTypescript: () => boolean): TypecheckConfig | false {
  if (raw === undefined || raw === null) {
    return hasTypescript() ? { preset: 'typescript', blocking: true } : false;
  }
  if (raw === false) return false;
  const check = mapping(raw, '"checks.typecheck"', 'or false');
  const known = ['preset', 'command', 'library', 'blocking', 'preludes'];
  onlyKnownKeys(check, known, 'checks.typecheck');
  const command = optionalString(check.command, 'checks.typecheck.command');
  const preset = parsePreset(check.preset, 'checks.typecheck.preset', command);
  const library = optionalString(check.library, 'checks.typecheck.library');
  const preludes = parsePreludes(check.preludes);

  const blocking = boolean(check.blocking, 'checks.typecheck.blocking', true);
  const config: TypecheckConfig = { blocking };
  if (preset !== undefined) config.preset = preset;
  if (command !== undefined) config.command = command;
  if (library !== undefined) config.library = library;
  if (preludes !== undefined) config.preludes = preludes;
  return config;
}

function parseCoverage(raw: unknown): CoverageConfig | false {
  if (raw === undefined || raw === null || raw === false) return false;
  const check = mapping(raw, '"checks.coverage"', 'or false');
  onlyKnownKeys(check, ['preset', 'command', 'entry', 'ignore', 'blocking'], 'checks.coverage');
  const command = optionalString(check.command, 'checks.coverage.command');
  const preset = parsePreset(check.preset, 'checks.coverage.preset', command);
  const entry = optionalString(check.entry, 'checks.coverage.entry');

  const config: CoverageConfig = {
    ignore: stringList(check.ignore, 'checks.coverage.ignore'),
    blocking: boolean(check.blocking, 'checks.coverage.blocking', false),
  };
  if (preset !== undefined) config.preset = preset;
  if (command !== undefined) config.command = command;
  if (entry !== undefined) config.entry = entry;
  return config;
}

/** The TypeScript preset is the only one; with no preset and no command it is implied. */
function parsePreset(
  raw: unknown,
  key: string,
  command: string | undefined,
): 'typescript' | undefined {
  if (raw === undefined) return command === undefined ? 'typescript' : undefined;
  if (raw !== 'typescript') {
    throw new ConfigError(
      `"${key}" must be "typescript" (got ${show(raw)}); use "command" for another language`,
    );
  }
  return raw;
}

function parsePreludes(raw: unknown): Record<string, string> | undefined {
  const preludes = optionalMapping(raw, 'checks.typecheck.preludes');
  if (preludes === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [skill, file] of Object.entries(preludes)) {
    if (!isNonEmptyString(file)) {
      throw new ConfigError(`"checks.typecheck.preludes.${skill}" must be a non-empty string`);
    }
    result[skill] = file;
  }
  return result;
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

function mapping(raw: unknown, what: string, detail = ''): Mapping {
  if (!isRecord(raw)) {
    throw new ConfigError(`${what} must be a mapping${detail ? ` ${detail}` : ''}`);
  }
  return raw;
}

function optionalMapping(raw: unknown, key: string): Mapping | undefined {
  return raw === undefined || raw === null ? undefined : mapping(raw, `"${key}"`);
}

function optionalString(raw: unknown, key: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isNonEmptyString(raw)) {
    throw new ConfigError(`"${key}" must be a non-empty string (got ${show(raw)})`);
  }
  return raw;
}

function stringList(raw: unknown, key: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every(isNonEmptyString)) {
    throw new ConfigError(`"${key}" must be a list of non-empty strings`);
  }
  return [...raw];
}

function requiredPath(raw: unknown, key: string, root: string): string {
  const resolved = optionalPath(raw, key, root);
  if (resolved === undefined) throw new ConfigError(`"${key}" is required`);
  return resolved;
}

function optionalPath(raw: unknown, key: string, root: string): string | undefined {
  const value = optionalString(raw, key);
  return value === undefined ? undefined : path.resolve(root, value);
}

function boolean(raw: unknown, key: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    throw new ConfigError(`"${key}" must be true or false (got ${show(raw)})`);
  }
  return raw;
}

function positiveInteger(raw: unknown, key: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new ConfigError(`"${key}" must be a positive integer (got ${show(raw)})`);
  }
  return raw;
}

function positiveNumber(raw: unknown, key: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new ConfigError(`"${key}" must be a positive number (got ${show(raw)})`);
  }
  return raw;
}
