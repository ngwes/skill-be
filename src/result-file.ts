/**
 * The committed result file, `skill-be.result.json`: one fingerprinted entry per skill.
 *
 * A run of some skills replaces only their entries, so one skill can be re-run on its own.
 * `verify` makes no model call: it recomputes each fingerprint and fails when a skill changed
 * since its entry was written, has no entry, or was blocked. The skill-be version is recorded but
 * does not take part in the match.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Either, Option, Try, TryAsync, filterSome, foldAsync } from '@ngwes/mini-fp';
import { all, check, firstProblem, valueOrThrow, type Checked } from './checked.js';
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
  skillBeVersion: string;
  /** Keyed by skill name. */
  skills: Record<string, SkillEntry>;
};

/** The version in skill-be's own `package.json`. */
export async function skillBeVersion(): Promise<string> {
  const manifest = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

/**
 * Reads the result file; null when there is none. A file that exists but is not a result file
 * (broken JSON, merge conflict markers, a missing key) throws a `ConfigError`: it is never
 * mistaken for a missing file, which a run would overwrite.
 */
export async function readResultFile(file: string): Promise<ResultFile | null> {
  const text = await TryAsync.runAsync(() => readFile(file, 'utf8')).match(
    (content) => Option.some(content),
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Option.none<string>();
      throw new ConfigError(`cannot read the result file ${file} (${(error as Error).message})`);
    },
  );
  return text.match<ResultFile | null>(
    (content) =>
      valueOrThrow(parseResultFile(content).mapLeft((message) => `${file}: ${message}`)),
    () => null,
  );
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
  const ordered: ResultFile = { skillBeVersion: result.skillBeVersion, skills };

  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  await TryAsync.runAsync(async () => {
    await writeFile(temp, JSON.stringify(ordered, null, 2) + '\n');
    await rename(temp, file);
  }).onFail(async (error) => {
    await rm(temp, { force: true });
    throw error;
  });
}

/**
 * The result file after a run: the entries of the skills in `updates` replace those of the same
 * skills, every other entry stays, and the version is the one of the run that updated the file.
 */
export function mergeResults(existing: ResultFile | null, updates: ResultFile): ResultFile {
  const kept = Option.from(existing)
    .map((file) => file.skills)
    .orElse({});
  return { skillBeVersion: updates.skillBeVersion, skills: { ...kept, ...updates.skills } };
}

/**
 * Checks the committed result against the files as they are now, without a model call. Only the
 * skills that have an eval file (the `suites`) need an entry, and each yields at most one
 * problem: no entry, a stale fingerprint, or a verdict that is not READY. Fix the stale ones
 * first: the verdict of an entry that no longer matches the files says nothing.
 */
export function verifyResults(
  config: Config,
  suites: SkillSuite[],
  file: ResultFile | null,
): Promise<{ ok: boolean; problems: string[] }> {
  return Option.from(file).matchAsync(
    async (results) => {
      const found = await foldAsync<SkillSuite, Option<string>[]>(
        suites,
        [],
        async (earlier, suite) => [
          ...earlier,
          await problemWith(config, suite, results.skills[suite.name]),
        ],
      );
      const problems = filterSome(found);
      return { ok: problems.length === 0, problems };
    },
    () => ({ ok: false, problems: ['no result file: run "skill-be run" first'] }),
  );
}

function problemWith(
  config: Config,
  suite: SkillSuite,
  entry: SkillEntry | undefined,
): Promise<Option<string>> {
  const rerun = `run "skill-be run ${suite.name}"`;
  return Option.from(entry).matchAsync(
    async (found) => {
      if (found.fingerprint !== (await skillFingerprint(config, suite))) {
        return Option.some(
          `skill "${suite.name}": changed since its last run ` +
            `(its SKILL.md, its eval file or the config); ${rerun}`,
        );
      }
      if (found.ready) return Option.none<string>();
      const reasons = found.reasons.length > 0 ? `: ${found.reasons.join('; ')}` : '';
      return Option.some(`skill "${suite.name}": NOT READY in its run of ${found.date}${reasons}`);
    },
    () => Option.some(`skill "${suite.name}": no entry in the result file; ${rerun}`),
  );
}

function parseResultFile(text: string): Either<string, ResultFile> {
  return Try.run(() => JSON.parse(text.replace(/^﻿/, '')) as unknown).match(
    (data) => firstProblem(resultFile(data)),
    (error) => Either.left(`invalid JSON (${(error as Error).message})`),
  );
}

/** The skills' entries first, in file order, then the version. */
function resultFile(data: unknown): Checked<ResultFile> {
  return object(data, 'the result file')
    .bind((root) =>
      all({
        skills: object(root.skills, '"skills"').bind((skills) =>
          all<Record<string, SkillEntry>>(
            Object.fromEntries(
              Object.entries(skills).map(([name, raw]) => [name, parseEntry(raw, `skills.${name}`)]),
            ),
          ),
        ),
        skillBeVersion: string(root.skillBeVersion, '"skillBeVersion"'),
      }),
    )
    .map(({ skills, skillBeVersion }) => ({ skillBeVersion, skills }));
}

function parseEntry(raw: unknown, where: string): Checked<SkillEntry> {
  const key = (name: string): string => `"${where}.${name}"`;
  return object(raw, `"${where}"`).bind((entry) =>
    all({
      date: string(entry.date, key('date')),
      fingerprint: string(entry.fingerprint, key('fingerprint')),
      ready: boolean(entry.ready, key('ready')),
      reasons: stringList(entry.reasons, key('reasons')),
      models: stringList(entry.models, key('models')),
      grader: string(entry.grader, key('grader')),
    }),
  );
}

function object(value: unknown, what: string): Checked<Record<string, unknown>> {
  return check(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    value as Record<string, unknown>,
    () => `${what} must be an object`,
  );
}

function string(value: unknown, what: string): Checked<string> {
  return check(typeof value === 'string', value as string, () => `${what} must be a string`);
}

function boolean(value: unknown, what: string): Checked<boolean> {
  return check(typeof value === 'boolean', value as boolean, () => `${what} must be true or false`);
}

function stringList(value: unknown, what: string): Checked<string[]> {
  return check(
    Array.isArray(value) && value.every((item) => typeof item === 'string'),
    value as string[],
    () => `${what} must be a list of strings`,
  ).map((list) => [...list]);
}
