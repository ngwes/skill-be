/**
 * The committed result file, `skillbe.result.json`: one fingerprinted entry per skill.
 *
 * A run of some skills replaces only their entries, so one skill can be re-run on its own.
 * `verify` makes no model call: it recomputes each fingerprint and fails when a skill changed
 * since its entry was written, has no entry, or was blocked. The skillBe version is recorded but
 * does not take part in the match.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { skillFingerprint } from './fingerprint.js';
import { ConfigError, type Config, type SkillSuite } from './types.js';

/** What the last run of one skill found. */
export type SkillEntry = {
  /** The date of the run, `YYYY-MM-DD`. */
  date: string;
  /** Of the skill's `SKILL.md`, its eval file and the config file, as the run saw them. */
  fingerprint: string;
  ready: boolean;
  /** The blocking reasons of the gate; empty when the skill is ready. */
  reasons: string[];
  /** The labels of the models under test. */
  models: string[];
  /** The id of the grader model. */
  grader: string;
};

export type ResultFile = {
  skillbeVersion: string;
  /** Keyed by skill name. */
  skills: Record<string, SkillEntry>;
};

/** The version in skillBe's own `package.json`. */
export async function skillbeVersion(): Promise<string> {
  const manifest = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

/**
 * Reads the result file; null when there is none. A file that exists but is not a result file
 * (broken JSON, merge conflict markers, a missing key) throws a `ConfigError`: it is never
 * mistaken for a missing file, which a run would overwrite.
 */
export async function readResultFile(file: string): Promise<ResultFile | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigError(`cannot read the result file ${file} (${(error as Error).message})`);
  }

  try {
    return parseResultFile(parseJson(text));
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${file}: ${error.message}`);
    throw error;
  }
}

/**
 * Writes the result file with a fixed key order, the skills sorted by name, two-space
 * indentation and a final newline, so that a new run changes as few lines as it can.
 *
 * The text goes to a temporary file in the same directory, which is then renamed over the result
 * file: a Ctrl+C or a full disk mid-write leaves the old file whole, never a truncated one.
 */
export async function writeResultFile(file: string, result: ResultFile): Promise<void> {
  const skills: Record<string, SkillEntry> = {};
  for (const name of Object.keys(result.skills).sort()) {
    const { date, fingerprint, ready, reasons, models, grader } = result.skills[name] as SkillEntry;
    skills[name] = { date, fingerprint, ready, reasons, models, grader };
  }
  const ordered: ResultFile = { skillbeVersion: result.skillbeVersion, skills };

  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(ordered, null, 2) + '\n');
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * The result file after a run: the entries of the skills in `updates` replace those of the same
 * skills, every other entry stays, and the version is the one of the run that updated the file.
 */
export function mergeResults(existing: ResultFile | null, updates: ResultFile): ResultFile {
  return {
    skillbeVersion: updates.skillbeVersion,
    skills: { ...existing?.skills, ...updates.skills },
  };
}

/**
 * Checks the committed result against the files as they are now, without a model call. Only the
 * skills that have an eval file (the `suites`) need an entry, and each yields at most one
 * problem: no entry, a stale fingerprint, or a verdict that is not READY. Fix the stale ones
 * first: the verdict of an entry that no longer matches the files says nothing.
 */
export async function verifyResults(
  config: Config,
  suites: SkillSuite[],
  file: ResultFile | null,
): Promise<{ ok: boolean; problems: string[] }> {
  if (file === null) return { ok: false, problems: ['no result file: run "skillbe run" first'] };

  const problems: string[] = [];
  for (const suite of suites) {
    const problem = await problemWith(config, suite, file.skills[suite.name]);
    if (problem !== undefined) problems.push(problem);
  }
  return { ok: problems.length === 0, problems };
}

async function problemWith(
  config: Config,
  suite: SkillSuite,
  entry: SkillEntry | undefined,
): Promise<string | undefined> {
  const rerun = `run "skillbe run ${suite.name}"`;
  if (entry === undefined) {
    return `skill "${suite.name}": no entry in the result file; ${rerun}`;
  }
  if (entry.fingerprint !== (await skillFingerprint(config, suite))) {
    return (
      `skill "${suite.name}": changed since its last run ` +
      `(its SKILL.md, its eval file or the config); ${rerun}`
    );
  }
  if (!entry.ready) {
    const reasons = entry.reasons.length > 0 ? `: ${entry.reasons.join('; ')}` : '';
    return `skill "${suite.name}": NOT READY in its run of ${entry.date}${reasons}`;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new ConfigError(`invalid JSON (${(error as Error).message})`);
  }
}

function parseResultFile(data: unknown): ResultFile {
  const root = object(data, 'the result file');
  const skills = object(root.skills, '"skills"');

  const entries: Record<string, SkillEntry> = {};
  for (const [name, raw] of Object.entries(skills)) {
    entries[name] = parseEntry(raw, `skills.${name}`);
  }
  return { skillbeVersion: string(root.skillbeVersion, '"skillbeVersion"'), skills: entries };
}

function parseEntry(raw: unknown, where: string): SkillEntry {
  const entry = object(raw, `"${where}"`);
  const key = (name: string): string => `"${where}.${name}"`;
  return {
    date: string(entry.date, key('date')),
    fingerprint: string(entry.fingerprint, key('fingerprint')),
    ready: boolean(entry.ready, key('ready')),
    reasons: stringList(entry.reasons, key('reasons')),
    models: stringList(entry.models, key('models')),
    grader: string(entry.grader, key('grader')),
  };
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ConfigError(`${what} must be a string`);
  return value;
}

function boolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(`${what} must be true or false`);
  return value;
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ConfigError(`${what} must be a list of strings`);
  }
  return [...(value as string[])];
}
