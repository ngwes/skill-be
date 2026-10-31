import * as fsp from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { skillFingerprint } from '../src/fingerprint.js';
import {
  mergeResults,
  readResultFile,
  skillBeVersion,
  verifyResults,
  writeResultFile,
  type ResultFile,
  type SkillEntry,
} from '../src/result-file.js';
import { loadSuites } from '../src/suite.js';
import { ConfigError, type Config, type SkillSuite } from '../src/types.js';

// The real functions, watched, so a test can see how the result file is written and fail a write.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'skill-be-result-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<SkillEntry> = {}): SkillEntry => ({
  date: '2026-10-31',
  fingerprint: 'f'.repeat(64),
  ready: true,
  reasons: [],
  models: ['claude-sonnet-5-5'],
  grader: 'claude-haiku-5-5',
  ...overrides,
});

const resultFile = (skills: Record<string, SkillEntry>, skillBeVersion = '1.0.0'): ResultFile => ({
  skillBeVersion,
  skills,
});

describe('skillBeVersion', () => {
  it("is the version in the package's own package.json", async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(await skillBeVersion()).toBe(manifest.version);
  });
});

describe('readResultFile', () => {
  it('returns null when there is no such file', async () => {
    expect(await readResultFile(path.join(dir, 'skill-be.result.json'))).toBeNull();
  });

  it('reads what writeResultFile wrote', async () => {
    const file = path.join(dir, 'skill-be.result.json');
    const written = resultFile({
      b: entry({ ready: false, reasons: ['**BLOCKED** (universal 0%): `s1`'] }),
      a: entry({ models: ['m1', 'm2'] }),
    });
    await writeResultFile(file, written);

    expect(await readResultFile(file)).toEqual(written);
  });

  const unreadable: [string, string, RegExp][] = [
    ['a file that is not JSON', '{ "skillBeVersion": ', /JSON/],
    ['a file with merge conflict markers', '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n', /JSON/],
    ['a JSON value that is not an object', '[]', /object/],
    ['a missing skillBeVersion', JSON.stringify({ skills: {} }), /skillBeVersion/],
    ['a missing skills key', JSON.stringify({ skillBeVersion: '1.0.0' }), /"skills"/],
    ['skills that is a list', JSON.stringify({ skillBeVersion: '1', skills: [] }), /"skills"/],
    [
      'an entry that is not an object',
      JSON.stringify({ skillBeVersion: '1', skills: { a: 1 } }),
      /"skills\.a" must be an object/,
    ],
    ...(['date', 'fingerprint', 'ready', 'reasons', 'models', 'grader'] as const).map(
      (key): [string, string, RegExp] => {
        const { [key]: _omitted, ...rest } = entry();
        return [
          `an entry without ${key}`,
          JSON.stringify({ skillBeVersion: '1', skills: { a: rest } }),
          new RegExp(`"skills\\.a\\.${key}"`),
        ];
      },
    ),
    [
      'reasons that are not strings',
      JSON.stringify({ skillBeVersion: '1', skills: { a: { ...entry(), reasons: [1] } } }),
      /"skills\.a\.reasons"/,
    ],
    [
      'a ready that is not a boolean',
      JSON.stringify({ skillBeVersion: '1', skills: { a: { ...entry(), ready: 'yes' } } }),
      /"skills\.a\.ready"/,
    ],
  ];

  it.each(unreadable)('rejects %s, naming the file', async (_name, text, pattern) => {
    const file = path.join(dir, 'skill-be.result.json');
    await writeFile(file, text);

    const error = await readResultFile(file).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(file);
    expect((error as ConfigError).message).toMatch(pattern);
  });

  it('reads a file saved with a byte order mark', async () => {
    const file = path.join(dir, 'skill-be.result.json');
    await writeFile(file, '﻿' + JSON.stringify(resultFile({ a: entry() })));

    expect(await readResultFile(file)).toEqual(resultFile({ a: entry() }));
  });
});

describe('writeResultFile', () => {
  it('writes a stable key order, skills by name, two spaces and a final newline', async () => {
    const file = path.join(dir, 'skill-be.result.json');
    // Built in a scrambled key order on purpose.
    const scrambled = {
      skills: {
        zeta: {
          grader: 'g',
          models: ['m'],
          reasons: ['r'],
          ready: false,
          fingerprint: 'abc',
          date: '2026-10-31',
        },
        alpha: {
          grader: 'g',
          models: [],
          reasons: [],
          ready: true,
          fingerprint: 'def',
          date: '2026-10-30',
        },
      },
      skillBeVersion: '1.2.3',
    } as ResultFile;

    await writeResultFile(file, scrambled);

    expect(await readFile(file, 'utf8')).toBe(
      [
        '{',
        '  "skillBeVersion": "1.2.3",',
        '  "skills": {',
        '    "alpha": {',
        '      "date": "2026-10-30",',
        '      "fingerprint": "def",',
        '      "ready": true,',
        '      "reasons": [],',
        '      "models": [],',
        '      "grader": "g"',
        '    },',
        '    "zeta": {',
        '      "date": "2026-10-31",',
        '      "fingerprint": "abc",',
        '      "ready": false,',
        '      "reasons": [',
        '        "r"',
        '      ],',
        '      "models": [',
        '        "m"',
        '      ],',
        '      "grader": "g"',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('writes the same bytes for the same content, whatever the order it was built in', async () => {
    const one = path.join(dir, 'one.json');
    const two = path.join(dir, 'two.json');

    await writeResultFile(one, resultFile({ a: entry(), b: entry({ date: '2026-01-01' }) }));
    await writeResultFile(two, resultFile({ b: entry({ date: '2026-01-01' }), a: entry() }));

    expect(await readFile(one, 'utf8')).toBe(await readFile(two, 'utf8'));
  });

  it('writes a temporary file beside the result file, then renames it over it', async () => {
    const file = path.join(dir, 'skill-be.result.json');
    await writeFile(file, 'the old result\n');
    vi.mocked(fsp.writeFile).mockClear();
    vi.mocked(fsp.rename).mockClear();

    await writeResultFile(file, resultFile({ a: entry() }));

    const written = vi.mocked(fsp.writeFile).mock.calls.map(([target]) => String(target));
    expect(written).toHaveLength(1);
    expect(written[0]).not.toBe(file);
    expect(path.dirname(written[0] as string)).toBe(dir);
    expect(vi.mocked(fsp.rename).mock.calls).toEqual([[written[0], file]]);
    expect(await readResultFile(file)).toEqual(resultFile({ a: entry() }));
    expect(await readdir(dir)).toEqual(['skill-be.result.json']);
  });

  it('leaves the old result file whole when the write is cut short', async () => {
    const file = path.join(dir, 'skill-be.result.json');
    await writeFile(file, 'the old result\n');
    const actual = await vi.importActual<typeof fsp>('node:fs/promises');
    vi.mocked(fsp.writeFile).mockImplementationOnce(async (target, data) => {
      await actual.writeFile(target, String(data).slice(0, 10));
      throw new Error('ENOSPC: no space left on device');
    });

    await expect(writeResultFile(file, resultFile({ a: entry() }))).rejects.toThrow(/ENOSPC/);

    expect(await readFile(file, 'utf8')).toBe('the old result\n');
    expect(await readdir(dir)).toEqual(['skill-be.result.json']);
  });

  it('creates the directory of the file and replaces an existing file', async () => {
    const file = path.join(dir, 'out', 'nested', 'result.json');

    await writeResultFile(file, resultFile({ a: entry() }));
    await writeResultFile(file, resultFile({ b: entry() }));

    expect(Object.keys((await readResultFile(file))!.skills)).toEqual(['b']);
  });

  it('does not write line endings other than LF', async () => {
    const file = path.join(dir, 'skill-be.result.json');

    await writeResultFile(file, resultFile({ a: entry({ reasons: ['line one\nline two'] }) }));

    expect(await readFile(file, 'utf8')).not.toContain('\r');
  });
});

describe('mergeResults', () => {
  it('is the update itself when there is no result file yet', () => {
    const updates = resultFile({ a: entry() }, '2.0.0');

    expect(mergeResults(null, updates)).toEqual(updates);
  });

  it("replaces only the updated skills' entries and keeps the others", () => {
    const existing = resultFile({
      a: entry({ date: '2026-01-01', fingerprint: 'old-a' }),
      b: entry({ date: '2026-01-02', fingerprint: 'old-b' }),
      c: entry({ date: '2026-01-03', fingerprint: 'old-c', ready: false, reasons: ['x'] }),
    });
    const updates = resultFile({ b: entry({ date: '2026-10-31', fingerprint: 'new-b' }) });

    const merged = mergeResults(existing, updates);

    expect(merged.skills).toEqual({
      a: existing.skills['a'],
      b: updates.skills['b'],
      c: existing.skills['c'],
    });
  });

  it('adds the entry of a skill that had none', () => {
    const existing = resultFile({ a: entry() });
    const updates = resultFile({ b: entry({ fingerprint: 'b-new' }) });

    expect(Object.keys(mergeResults(existing, updates).skills).sort()).toEqual(['a', 'b']);
  });

  it('records the version of the run that updated the file', () => {
    const merged = mergeResults(
      resultFile({ a: entry() }, '1.0.0'),
      resultFile({ b: entry() }, '1.1.0'),
    );

    expect(merged.skillBeVersion).toBe('1.1.0');
  });

  it('changes neither argument', () => {
    const existing = resultFile({ a: entry() }, '1.0.0');
    const updates = resultFile({ b: entry() }, '1.1.0');
    const existingBefore = structuredClone(existing);
    const updatesBefore = structuredClone(updates);

    mergeResults(existing, updates);

    expect(existing).toEqual(existingBefore);
    expect(updates).toEqual(updatesBefore);
  });
});

const CONFIG_YAML = [
  'skills: ./skills',
  'evals: ./evals',
  'model:',
  '  adapter: command',
  '  id: fake',
  'grader:',
  '  adapter: command',
  '  id: fake',
  '',
].join('\n');
const EVAL_JSON =
  JSON.stringify(
    { scenarios: [{ id: 's1', critical: false, prompt: 'Do it.', criteria: ['It is done'] }] },
    null,
    2,
  ) + '\n';

describe('verifyResults', () => {
  let config: Config;
  let suites: SkillSuite[];

  async function put(name: string, content: string): Promise<void> {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  /** A project with the skills `a` and `b` (both with evals) and `c` (without an eval file). */
  async function load(): Promise<void> {
    config = await loadConfig(path.join(dir, 'skill-be.yaml'), {
      typescriptInstalled: () => false,
    });
    suites = (await loadSuites(config)).suites;
  }

  beforeEach(async () => {
    await put('skill-be.yaml', CONFIG_YAML);
    for (const name of ['a', 'b', 'c']) await put(`skills/${name}/SKILL.md`, `# Skill ${name}\n`);
    for (const name of ['a', 'b']) await put(`evals/${name}.json`, EVAL_JSON);
    await load();
  });

  const current = async (name: string, overrides: Partial<SkillEntry> = {}): Promise<SkillEntry> =>
    entry({ fingerprint: await skillFingerprint(config, suiteNamed(name)), ...overrides });

  const suiteNamed = (name: string): SkillSuite => suites.find((s) => s.name === name)!;

  it('passes when every suite has a current, ready entry', async () => {
    const file = resultFile({ a: await current('a'), b: await current('b') });

    expect(await verifyResults(config, suites, file)).toEqual({ ok: true, problems: [] });
  });

  it('does not require an entry for a skill without an eval file', async () => {
    const file = resultFile({ a: await current('a'), b: await current('b') });

    expect(suites.map((s) => s.name)).toEqual(['a', 'b']); // skill "c" has no eval file
    expect(await verifyResults(config, suites, file)).toEqual({ ok: true, problems: [] });
  });

  it('ignores entries of skills that are no longer there', async () => {
    const file = resultFile({
      a: await current('a'),
      b: await current('b'),
      gone: entry({ ready: false }),
    });

    expect(await verifyResults(config, suites, file)).toEqual({ ok: true, problems: [] });
  });

  it('passes when there is nothing to verify', async () => {
    expect(await verifyResults(config, [], resultFile({}))).toEqual({ ok: true, problems: [] });
  });

  it('reports a missing result file as a single problem', async () => {
    expect(await verifyResults(config, suites, null)).toEqual({
      ok: false,
      problems: ['no result file: run "skill-be run" first'],
    });
  });

  it('reports one problem for a skill with no entry', async () => {
    const file = resultFile({ a: await current('a') });

    const verdict = await verifyResults(config, suites, file);

    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain('"b"');
    expect(verdict.problems[0]).toMatch(/no entry/);
    expect(verdict.problems[0]).toContain('skill-be run b');
  });

  it('reports one problem for a skill whose fingerprint is stale', async () => {
    const file = resultFile({ a: await current('a'), b: await current('b') });
    await put('skills/b/SKILL.md', '# Skill b, edited\n');

    const verdict = await verifyResults(config, suites, file);

    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain('"b"');
    expect(verdict.problems[0]).toMatch(/changed/);
    expect(verdict.problems[0]).toContain('skill-be run b');
  });

  it('reports a stale fingerprint when only the eval file changed', async () => {
    const file = resultFile({ a: await current('a'), b: await current('b') });
    await put('evals/a.json', EVAL_JSON.replace('Do it.', 'Do it!'));

    const verdict = await verifyResults(config, suites, file);

    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain('"a"');
  });

  it('reports a stale fingerprint for every skill when the config changed', async () => {
    const file = resultFile({ a: await current('a'), b: await current('b') });
    await put('skill-be.yaml', CONFIG_YAML + 'reps: 5\n');

    const verdict = await verifyResults(config, suites, file);

    expect(verdict.problems).toHaveLength(2);
    expect(verdict.problems[0]).toContain('"a"');
    expect(verdict.problems[1]).toContain('"b"');
  });

  it('reports one problem for a skill that is not ready, with its reasons', async () => {
    const reason = '**BLOCKED** (universal 0%): `s1` — criterion: *"It is done"*';
    const file = resultFile({
      a: await current('a', { ready: false, reasons: [reason], date: '2026-10-30' }),
      b: await current('b'),
    });

    const verdict = await verifyResults(config, suites, file);

    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain('"a"');
    expect(verdict.problems[0]).toMatch(/NOT READY/);
    expect(verdict.problems[0]).toContain(reason);
  });

  it('reports a skill that is both stale and not ready once, as stale', async () => {
    const file = resultFile({
      a: entry({ fingerprint: 'stale', ready: false, reasons: ['x'] }),
      b: await current('b'),
    });

    const verdict = await verifyResults(config, suites, file);

    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toMatch(/changed/);
  });

  it('reports the problems of several skills in the order of the suites', async () => {
    const file = resultFile({ b: entry({ fingerprint: 'stale' }) });

    const verdict = await verifyResults(config, suites, file);

    expect(verdict.problems).toHaveLength(2);
    expect(verdict.problems[0]).toContain('"a"');
    expect(verdict.problems[1]).toContain('"b"');
  });

  it('does not match the skill-be version', async () => {
    const file = resultFile({ a: await current('a'), b: await current('b') }, '0.0.1-old');

    expect((await verifyResults(config, suites, file)).ok).toBe(true);
  });

  it('is not fooled by CRLF line endings on a checkout of the same files', async () => {
    const file = resultFile({ a: await current('a'), b: await current('b') });
    await put('skills/a/SKILL.md', '# Skill a\r\n');
    await put('skill-be.yaml', CONFIG_YAML.replace(/\n/g, '\r\n'));
    await put('evals/b.json', EVAL_JSON.replace(/\n/g, '\r\n'));

    const verdict = await verifyResults(config, suites, file);

    expect(verdict).toEqual({ ok: true, problems: [] });
  });
});
