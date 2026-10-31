import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, type Config, type Scenario, type SkillSuite } from './types.js';

type Skill = { name: string; skillPath: string; skillText: string };

/**
 * Pairs every skill folder (one holding a `SKILL.md`) with its eval file `<evals>/<skill>.json`.
 * A skill with no eval file is skipped with a warning. `only` limits the run to the named skills.
 */
export async function loadSuites(
  config: Config,
  only?: string[],
): Promise<{ suites: SkillSuite[]; warnings: string[] }> {
  const skills = await findSkills(config.skills);
  const selected = select(skills, only ?? [], config.skills);

  const suites: SkillSuite[] = [];
  const warnings: string[] = [];
  for (const skill of selected) {
    const evalPath = path.join(config.evals, `${skill.name}.json`);
    const evalText = await readIfPresent(evalPath);
    if (evalText === undefined) {
      warnings.push(`skill "${skill.name}" has no eval file`);
      continue;
    }
    suites.push({ ...skill, evalPath, scenarios: parseScenarios(evalText, evalPath) });
  }
  return { suites, warnings };
}

async function findSkills(skillsDir: string): Promise<Skill[]> {
  let names: string[];
  try {
    names = await readdir(skillsDir);
  } catch (error) {
    const reason = (error as Error).message;
    throw new ConfigError(`cannot read the skills directory ${skillsDir} (${reason})`);
  }

  const skills: Skill[] = [];
  for (const name of names.sort()) {
    const skillPath = path.join(skillsDir, name, 'SKILL.md');
    const skillText = await readIfPresent(skillPath);
    if (skillText !== undefined) skills.push({ name, skillPath, skillText });
  }
  return skills;
}

function select(skills: Skill[], only: string[], skillsDir: string): Skill[] {
  if (only.length === 0) return skills;
  for (const name of only) {
    if (!skills.some((skill) => skill.name === name)) {
      const available = skills.map((skill) => skill.name).join(', ') || 'none';
      throw new ConfigError(`unknown skill "${name}" (skills in ${skillsDir}: ${available})`);
    }
  }
  return skills.filter((skill) => only.includes(skill.name));
}

/** The file's text without a byte order mark, or undefined when there is no such file. */
async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, 'utf8')).replace(/^﻿/, '');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new ConfigError(`cannot read ${file} (${(error as Error).message})`);
  }
}

function parseScenarios(text: string, file: string): Scenario[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file}: invalid JSON (${(error as Error).message})`);
  }

  const list = isRecord(data) ? data.scenarios : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError(`${file}: "scenarios" must be a non-empty list`);
  }

  const ids = new Set<string>();
  return list.map((raw, index) => {
    const scenario = parseScenario(raw, index, file);
    if (ids.has(scenario.id)) {
      throw new ConfigError(`${file}: duplicate scenario id "${scenario.id}"`);
    }
    ids.add(scenario.id);
    return scenario;
  });
}

function parseScenario(raw: unknown, index: number, file: string): Scenario {
  if (!isRecord(raw)) throw new ConfigError(`${file}: "scenarios[${index}]" must be an object`);

  const { id, critical, prompt, criteria } = raw;
  if (!isNonEmptyString(id)) {
    throw new ConfigError(`${file}: scenarios[${index}]: "id" must be a non-empty string`);
  }
  const where = `${file}: scenario "${id}"`;
  if (critical !== undefined && typeof critical !== 'boolean') {
    throw new ConfigError(`${where}: "critical" must be true or false`);
  }
  if (!isNonEmptyString(prompt)) {
    throw new ConfigError(`${where}: "prompt" must be a non-empty string`);
  }
  if (!Array.isArray(criteria) || criteria.length === 0 || !criteria.every(isNonEmptyString)) {
    throw new ConfigError(`${where}: "criteria" must be a non-empty list of non-empty strings`);
  }
  return { id, critical: critical ?? false, prompt, criteria: [...criteria] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
