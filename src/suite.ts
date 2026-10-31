import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  Either,
  Option,
  Try,
  TryAsync,
  foldAsync,
  sequenceValidate,
  traverseEither,
} from '@ngwes/mini-fp';
import { all, check, fail, firstProblem, pass, valueOrThrow, type Checked } from './checked.js';
import { ConfigError, type Config, type Scenario, type SkillSuite } from './types.js';

type Skill = { name: string; skillPath: string; skillText: string };

type Loaded = { suites: SkillSuite[]; warnings: string[] };

/**
 * Pairs every skill folder (one holding a `SKILL.md`) with its eval file `<evals>/<skill>.json`.
 * A skill with no eval file is skipped with a warning. `only` limits the run to the named skills.
 */
export async function loadSuites(config: Config, only?: string[]): Promise<Loaded> {
  const skills = await findSkills(config.skills);
  const selected = select(skills, only ?? [], config.skills);

  return foldAsync<Skill, Loaded>(
    selected,
    { suites: [], warnings: [] },
    async ({ suites, warnings }, skill) => {
      const evalPath = path.join(config.evals, `${skill.name}.json`);
      return (await readIfPresent(evalPath)).match<Loaded>(
        (evalText) => ({
          suites: [...suites, { ...skill, evalPath, scenarios: scenariosOf(evalText, evalPath) }],
          warnings,
        }),
        () => ({ suites, warnings: [...warnings, `skill "${skill.name}" has no eval file`] }),
      );
    },
  );
}

async function findSkills(skillsDir: string): Promise<Skill[]> {
  const names = await TryAsync.runAsync(() => readdir(skillsDir)).onFail((error) => {
    const reason = (error as Error).message;
    throw new ConfigError(`cannot read the skills directory ${skillsDir} (${reason})`);
  });

  return foldAsync<string, Skill[]>(names.sort(), [], async (skills, name) => {
    const skillPath = path.join(skillsDir, name, 'SKILL.md');
    return (await readIfPresent(skillPath)).match(
      (skillText) => [...skills, { name, skillPath, skillText }],
      () => skills,
    );
  });
}

function select(skills: Skill[], only: string[], skillsDir: string): Skill[] {
  if (only.length === 0) return skills;
  const available = skills.map((skill) => skill.name).join(', ') || 'none';
  const known = only.map((name) =>
    skills.some((skill) => skill.name === name)
      ? Either.right<string, string>(name)
      : Either.left<string, string>(`unknown skill "${name}" (skills in ${skillsDir}: ${available})`),
  );
  return valueOrThrow(
    traverseEither(known).map(() => skills.filter((skill) => only.includes(skill.name))),
  );
}

/** The file's text without a byte order mark, or none when there is no such file. */
function readIfPresent(file: string): Promise<Option<string>> {
  return TryAsync.runAsync(() => readFile(file, 'utf8')).match(
    (text) => Option.some(text.replace(/^﻿/, '')),
    (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return Option.none<string>();
      throw new ConfigError(`cannot read ${file} (${(error as Error).message})`);
    },
  );
}

/** The scenarios of an eval file; a `ConfigError` naming the file when they are not valid. */
function scenariosOf(text: string, file: string): Scenario[] {
  return valueOrThrow(parseScenarios(text).mapLeft((message) => `${file}: ${message}`));
}

function parseScenarios(text: string): Either<string, Scenario[]> {
  return Try.run(() => Option.from<unknown>(JSON.parse(text)))
    .toEither()
    .mapLeft((error) => `invalid JSON (${(error as Error).message})`)
    .bind((data) => firstProblem(scenarioList(data)));
}

/** Every scenario checked, in file order: its own keys, then whether an earlier one has its id. */
function scenarioList(data: Option<unknown>): Checked<Scenario[]> {
  const list = data.match(
    (value) => (isRecord(value) ? value.scenarios : undefined),
    () => undefined,
  );
  if (!Array.isArray(list) || list.length === 0) return fail('"scenarios" must be a non-empty list');

  return sequenceValidate(
    list.map((raw, index) =>
      parseScenario(raw, index).bind((scenario) =>
        check(
          !list.slice(0, index).some((earlier) => isRecord(earlier) && earlier.id === scenario.id),
          scenario,
          () => `duplicate scenario id "${scenario.id}"`,
        ),
      ),
    ),
  );
}

function parseScenario(raw: unknown, index: number): Checked<Scenario> {
  if (!isRecord(raw)) return fail(`"scenarios[${index}]" must be an object`);

  const { id, critical, prompt, criteria } = raw;
  return check(
    isNonEmptyString(id),
    id as string,
    () => `scenarios[${index}]: "id" must be a non-empty string`,
  ).bind((id) => {
    const where = `scenario "${id}"`;
    return all<Scenario>({
      id: pass(id),
      critical: check(
        critical === undefined || typeof critical === 'boolean',
        (critical ?? false) as boolean,
        () => `${where}: "critical" must be true or false`,
      ),
      prompt: check(
        isNonEmptyString(prompt),
        prompt as string,
        () => `${where}: "prompt" must be a non-empty string`,
      ),
      criteria: check(
        Array.isArray(criteria) && criteria.length > 0 && criteria.every(isNonEmptyString),
        criteria as string[],
        () => `${where}: "criteria" must be a non-empty list of non-empty strings`,
      ).map((list) => [...list]),
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
