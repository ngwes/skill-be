import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { skillFingerprint } from '../src/fingerprint.js';
import type { RunSummary } from '../src/report.js';
import type { ResultFile } from '../src/result-file.js';
import { loadSuites } from '../src/suite.js';

const BIN = fileURLToPath(new URL('./fixtures/bin/', import.meta.url));
const TYPECHECK = fileURLToPath(new URL('./fixtures/typecheck/', import.meta.url));
const READY_LINE = '**READY** — No universal 0% criteria. No critical regressions.';

/** A command line for a fixture script, run with this node; YAML-quoted. */
const command = (script: string, ...args: string[]): string =>
  JSON.stringify([process.execPath, script, ...args].map((word) => `"${word}"`).join(' '));

// Every test runs real child processes through the command adapter.
const SLOW = { timeout: 60_000 };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'skill-be-cli-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

type ProjectOptions = {
  /** What the fake grader answers to every criterion. */
  grader?: 'yes' | 'no';
  reps?: number;
  /** The `checks` mapping, as YAML lines indented by two spaces. */
  checks?: string[];
  /** The model's `run` setting, as YAML. */
  modelRun?: string;
};

function configText(opts: ProjectOptions = {}): string {
  return [
    'skills: ./skills',
    'evals: ./evals',
    'model:',
    '  adapter: command',
    '  id: fake-model',
    `  run: ${opts.modelRun ?? command(path.join(BIN, 'fake-cli.mjs'))}`,
    'grader:',
    '  adapter: command',
    '  id: fake-grader',
    `  run: ${command(path.join(BIN, 'fake-cli.mjs'), opts.grader ?? 'yes')}`,
    `reps: ${opts.reps ?? 1}`,
    'gradings: 1',
    'checks:',
    ...(opts.checks ?? ['  typecheck: false']),
    '',
  ].join('\n');
}

const EVAL = {
  scenarios: [
    {
      id: 'double-a-number',
      critical: true,
      prompt: 'Write a function that returns twice the value it is given.',
      criteria: ['Calls double()', 'Returns a number'],
    },
  ],
};

async function writeSkill(name: string, text: string, withEval = true): Promise<void> {
  await mkdir(path.join(root, 'skills', name), { recursive: true });
  await writeFile(path.join(root, 'skills', name, 'SKILL.md'), text);
  if (withEval) {
    await mkdir(path.join(root, 'evals'), { recursive: true });
    await writeFile(path.join(root, 'evals', `${name}.json`), JSON.stringify(EVAL, null, 2));
  }
}

/** Skill `a` with an eval file, skill `b` without one, and the config. */
async function makeProject(opts: ProjectOptions = {}, skillText = '# A\n\nUse `double(n)`.\n') {
  await writeSkill('a', skillText);
  await writeSkill('b', '# B\n', false);
  await writeFile(path.join(root, 'skill-be.yaml'), configText(opts));
}

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    cwd: root,
  });
  return { code, stdout, stderr };
}

const resultsDir = (): string => path.join(root, '.skill-be', 'results');

/** The only run directory under the results. */
async function runDir(): Promise<string> {
  const names = await readdir(resultsDir());
  expect(names).toHaveLength(1);
  return path.join(resultsDir(), names[0] as string);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

const resultFile = (): Promise<ResultFile> => readJson(path.join(root, 'skill-be.result.json'));

describe('skill-be run', SLOW, () => {
  it('exits 0 and writes the report, the summary and the result file', async () => {
    await makeProject();

    const { code, stdout, stderr } = await cli('run');

    expect(code).toBe(0);
    const dir = await runDir();
    expect(path.basename(dir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    const report = await readFile(path.join(dir, 'a.md'), 'utf8');
    expect(report).toContain('## Release Gate');
    expect(report).toContain(READY_LINE);
    expect(report.endsWith('\n\n')).toBe(true);
    expect(stdout).toContain(report);
    expect(stdout).toMatch(/a: READY/);
    expect(stdout).toContain(path.join('.skill-be', 'results', path.basename(dir), 'a.md'));
    expect(stdout).toContain(path.join('.skill-be', 'results', path.basename(dir), 'summary.json'));
    expect(stdout).toContain('skill-be.result.json');
    expect(stderr).toContain('skill "b" has no eval file');

    const summary = await readJson<RunSummary>(path.join(dir, 'summary.json'));
    expect(summary.skills.map((s) => [s.skill, s.ready])).toEqual([['a', true]]);

    const config = await loadConfig(path.join(root, 'skill-be.yaml'));
    const [suite] = (await loadSuites(config)).suites;
    const result = await resultFile();
    expect(result.skills).toEqual({
      a: {
        date: summary.skills[0]?.startedAt.slice(0, 10),
        fingerprint: await skillFingerprint(config, suite!),
        ready: true,
        reasons: [],
        models: ['fake-model'],
        grader: 'fake-grader',
      },
    });
  });

  it('exits 1 with a NOT READY report when the grader says NO', async () => {
    await makeProject({ grader: 'no' });

    const { code, stdout } = await cli('run');

    expect(code).toBe(1);
    const report = await readFile(path.join(await runDir(), 'a.md'), 'utf8');
    expect(report).toContain('**NOT READY**');
    expect(report).toContain('- **BLOCKED** (universal 0%): `double-a-number`');
    expect(stdout).toMatch(/a: NOT READY/);
    const entry = (await resultFile()).skills.a;
    expect(entry?.ready).toBe(false);
    expect(entry?.reasons).toHaveLength(2);
  });

  it('lets --reps override the config', async () => {
    await makeProject({ reps: 3 });

    const { code } = await cli('run', '--reps', '1');

    expect(code).toBe(0);
    const dir = await runDir();
    expect(await readFile(path.join(dir, 'a.md'), 'utf8')).toContain('Reps: 1.');
    const outputs = await readdir(path.join(dir, 'a', 'double-a-number', 'fake-model'));
    expect(outputs.filter((name) => !name.startsWith('rep-1-'))).toEqual([]);
    expect(outputs).toContain('rep-1-with-skill.md');
  });

  it('runs every skill under one timestamp and keeps the other result entries', async () => {
    await makeProject();
    await writeSkill('c', '# C\n');
    const other = {
      date: '2026-01-01',
      fingerprint: 'abc',
      ready: true,
      reasons: [],
      models: ['m'],
      grader: 'g',
    };
    await writeFile(
      path.join(root, 'skill-be.result.json'),
      JSON.stringify({ skillBeVersion: '0.0.1', skills: { other } }),
    );

    const { code, stderr } = await cli('run', '--concurrency=2');

    expect(code).toBe(0);
    expect(stderr).toContain('concurrency 2');
    const dir = await runDir();
    expect((await readdir(dir)).sort()).toEqual(['a', 'a.md', 'c', 'c.md', 'summary.json']);
    const summary = await readJson<RunSummary>(path.join(dir, 'summary.json'));
    expect(summary.skills.map((s) => s.skill)).toEqual(['a', 'c']);
    expect(Object.keys((await resultFile()).skills)).toEqual(['a', 'c', 'other']);
    expect((await resultFile()).skills.other).toEqual(other);
  });

  it('runs only the named skills', async () => {
    await makeProject();
    await writeSkill('c', '# C\n');

    const { code } = await cli('run', 'c');

    expect(code).toBe(0);
    expect(await readdir(await runDir())).not.toContain('a.md');
    expect(Object.keys((await resultFile()).skills)).toEqual(['c']);
  });

  it('exits 1 when a blocking typecheck fails, even though every skill is READY', async () => {
    await makeProject(
      { checks: ['  typecheck:', '    preset: typescript'] },
      '# A\n\n```ts\nconst n: number = "two";\n```\n',
    );

    const { code, stdout } = await cli('run');

    expect(code).toBe(1);
    expect(stdout).toMatch(/a: READY/);
    expect(stdout).toContain('skill "a", SKILL.md line 4');
    expect((await resultFile()).skills.a?.ready).toBe(true);
  });

  it('runs coverage over every skill, not only the named ones', async () => {
    const listApi = command(path.join(TYPECHECK, 'list-api.mjs'), 'onlyInC');
    await makeProject({
      checks: [
        '  typecheck: false',
        '  coverage:',
        `    command: ${listApi}`,
        '    blocking: true',
      ],
    });
    await writeSkill('c', '# C\n\nUse `onlyInC`.\n');

    const { code, stdout } = await cli('run', 'a');

    expect(code).toBe(0);
    expect(stdout).not.toContain('not mentioned');
  });

  it('exits 2 when an adapter reports a config error', async () => {
    await makeProject({ modelRun: JSON.stringify('node "unclosed') });

    const { code, stderr } = await cli('run');

    expect(code).toBe(2);
    expect(stderr).toContain('unclosed quote');
    expect(existsSync(path.join(root, 'skill-be.result.json'))).toBe(false);
  });

  it('exits 2 in CI when an apiKeyEnv variable is unset, naming the variable', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('SKILL_BE_TEST_KEY', undefined);
    await makeProject();
    const config = configText().replace(
      /model:\n {2}adapter: command\n {2}id: fake-model\n {2}run: .*\n/,
      // A bin that cannot start: outside CI the call would fail differently.
      'model:\n  adapter: claude-cli\n  id: fake-model\n  bin: skill-be-no-such-cli\n' +
        '  apiKeyEnv: SKILL_BE_TEST_KEY\n',
    );
    expect(config).toContain('apiKeyEnv');
    await writeFile(path.join(root, 'skill-be.yaml'), config);

    const { code, stderr } = await cli('run');

    expect(code).toBe(2);
    expect(stderr).toContain('$SKILL_BE_TEST_KEY');
    expect(stderr).not.toContain('skill-be-no-such-cli');
    expect(existsSync(path.join(root, 'skill-be.result.json'))).toBe(false);
  });

  it('exits 2 and leaves the result file alone when the model CLI cannot start', async () => {
    await makeProject();
    expect((await cli('run')).code).toBe(0);
    const before = await readFile(path.join(root, 'skill-be.result.json'), 'utf8');
    await writeFile(
      path.join(root, 'skill-be.yaml'),
      configText({ modelRun: 'skill-be-no-such-cli' }),
    );

    const { code, stdout, stderr } = await cli('run');

    expect(code).toBe(2);
    expect(stderr).toContain('skill-be-no-such-cli');
    expect(stdout).not.toContain('NOT READY');
    expect(await readFile(path.join(root, 'skill-be.result.json'), 'utf8')).toBe(before);
  });

  it('exits 2 on an invalid result file, before any model call', async () => {
    await makeProject();
    await writeFile(path.join(root, 'skill-be.result.json'), '<<<<<<< HEAD\n');

    const { code, stderr } = await cli('run');

    expect(code).toBe(2);
    expect(stderr).toContain('skill-be.result.json');
    expect(existsSync(resultsDir())).toBe(false);
  });

  it.each([
    [
      'a typecheck command with an unclosed quote',
      ['  typecheck:', '    command: node "x'],
      'unclosed quote',
    ],
    [
      'an unresolvable typecheck library',
      ['  typecheck:', '    library: skill-be-no-such-lib'],
      'skill-be-no-such-lib',
    ],
    [
      'a coverage preset with no entry',
      ['  typecheck: false', '  coverage:', '    preset: typescript'],
      'checks.coverage.entry',
    ],
  ])('exits 2 on %s, before any model call', async (_, checks, message) => {
    await makeProject({ checks });

    const { code, stderr } = await cli('run');

    expect(code).toBe(2);
    expect(stderr).toContain(message);
    expect(existsSync(resultsDir())).toBe(false);
  });

  it('exits 2 when no skill has an eval file, with the warnings', async () => {
    await makeProject();
    await unlink(path.join(root, 'evals', 'a.json'));

    const { code, stderr } = await cli('run');

    expect(code).toBe(2);
    expect(stderr).toContain('skill "a" has no eval file');
    expect(stderr).toMatch(/no skill to run/);
  });

  it('exits 2 when the named skills have no eval file', async () => {
    await makeProject();

    const { code, stderr } = await cli('run', 'b');

    expect(code).toBe(2);
    expect(stderr).toContain('skill "b" has no eval file');
  });

  it('exits 2 for an unknown skill', async () => {
    await makeProject();

    const { code, stderr } = await cli('run', 'zzz');

    expect(code).toBe(2);
    expect(stderr).toContain('unknown skill "zzz"');
  });
});

describe('skill-be verify', SLOW, () => {
  it('exits 0 right after a passing run, and 1 once a SKILL.md changed', async () => {
    await makeProject();
    expect((await cli('run')).code).toBe(0);

    const passing = await cli('verify');
    expect(passing.code).toBe(0);
    expect(passing.stdout).toContain('result file');

    await writeFile(path.join(root, 'skills', 'a', 'SKILL.md'), '# A\n\nUse `double(n)`!\n');
    const stale = await cli('verify');
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain('skill "a": changed since its last run');
  });

  it('exits 1 when the last run was NOT READY', async () => {
    await makeProject({ grader: 'no' });
    await cli('run');

    const { code, stdout } = await cli('verify');

    expect(code).toBe(1);
    expect(stdout).toContain('skill "a": NOT READY');
  });

  it('exits 1 when there is no result file', async () => {
    await makeProject();

    const { code, stdout } = await cli('verify');

    expect(code).toBe(1);
    expect(stdout).toContain('no result file');
  });

  it('exits 1 when a typecheck problem exists, though the result file matches', async () => {
    const checkBlock = command(path.join(TYPECHECK, 'check-block.mjs'));
    await makeProject(
      { checks: ['  typecheck:', `    command: ${checkBlock}`] },
      '# A\n\n```ts\nBAD\n```\n',
    );
    await cli('run');

    const { code, stdout } = await cli('verify');

    expect(code).toBe(1);
    expect(stdout).not.toContain('skill "a": changed');
    expect(stdout).toContain('rejected (ts): BAD');
  });

  it('exits 2 on a result file with conflict markers', async () => {
    await makeProject();
    await writeFile(path.join(root, 'skill-be.result.json'), '<<<<<<< HEAD\n{}\n');

    const { code, stderr } = await cli('verify');

    expect(code).toBe(2);
    expect(stderr).toContain('invalid JSON');
  });

  it('exits 2 when no skill has an eval file', async () => {
    await makeProject();
    await unlink(path.join(root, 'evals', 'a.json'));

    expect((await cli('verify')).code).toBe(2);
  });
});

describe('skill-be check', SLOW, () => {
  it('exits 1 on a blocking typecheck problem and prints the skipped blocks', async () => {
    await makeProject(
      { checks: ['  typecheck:', '    preset: typescript'] },
      '# A\n\n```ts\nconst n: number = "two";\n```\n\n```ts\nconst f = async x => …;\n```\n',
    );

    const { code, stdout } = await cli('check');

    expect(code).toBe(1);
    expect(stdout).toContain('skill "a", SKILL.md line 4');
    expect(stdout).toContain('the block does not parse, skipped');
  });

  it('exits 0 when the typecheck problem does not block', async () => {
    await makeProject(
      { checks: ['  typecheck:', '    preset: typescript', '    blocking: false'] },
      '# A\n\n```ts\nconst n: number = "two";\n```\n',
    );

    const { code, stdout } = await cli('check');

    expect(code).toBe(0);
    expect(stdout).toContain('skill "a", SKILL.md line 4');
  });

  it('prints the missing names of coverage, which blocks only when configured to', async () => {
    const listApi = command(path.join(TYPECHECK, 'list-api.mjs'), 'double', 'triple', 'halve');
    const checks = (blocking: boolean) => [
      '  typecheck: false',
      '  coverage:',
      `    command: ${listApi}`,
      `    blocking: ${blocking}`,
    ];
    await makeProject({ checks: checks(false) });

    const warning = await cli('check');
    expect(warning.code).toBe(0);
    expect(warning.stdout).toContain('halve, triple');

    await writeFile(path.join(root, 'skill-be.yaml'), configText({ checks: checks(true) }));
    const blocking = await cli('check');
    expect(blocking.code).toBe(1);
    expect(blocking.stdout).toContain('halve, triple');
  });

  it('exits 2 when no skill has an eval file', async () => {
    await makeProject();
    await unlink(path.join(root, 'evals', 'a.json'));

    expect((await cli('check')).code).toBe(2);
  });
});

describe('skill-be triage', SLOW, () => {
  it('exits 2 when there is no run to triage', async () => {
    await makeProject();

    const { code, stderr } = await cli('triage');

    expect(code).toBe(2);
    expect(stderr).toContain('run `skill-be run` before triage');
  });

  it.each([
    ['--below', '101'],
    ['--below', '-1'],
    ['--below', 'half'],
    ['--samples', '0'],
    ['--samples', '1.5'],
  ])('exits 2 for %s %s', async (flag, value) => {
    await makeProject();

    const { code, stderr } = await cli('triage', flag, value);

    expect(code).toBe(2);
    expect(stderr).toContain(flag);
  });

  it('triages the latest run and prints the report path', async () => {
    await makeProject({ grader: 'no' });
    await cli('run');

    const { code, stdout } = await cli('triage', 'a', '--samples', '1', '--below', '50');

    expect(code).toBe(0);
    const reportName = (await readdir(await runDir())).find((name) => name.startsWith('triage-'));
    expect(reportName).toBeDefined();
    expect(stdout).toContain(reportName);
    expect(stdout).toContain('"Calls double()"');
  });
});

describe('usage', () => {
  const helps = [['--help'], ['-h'], ['help'], ['run', '--help']];
  it.each(helps)('%s prints the usage', async (...a) => {
    const { code, stdout } = await cli(...a);

    expect(code).toBe(0);
    expect(stdout).toMatch(/^Usage: skill-be <command>/);
    for (const name of ['run', 'verify', 'check', 'triage']) expect(stdout).toContain(name);
  });

  it.each([
    [[], 'no command'],
    [['bench'], 'unknown command "bench"'],
    [['run', '--fast'], 'unknown option --fast'],
    [['verify', '--reps', '1'], 'unknown option --reps'],
    [['run', '--reps'], '--reps needs a value'],
    [['run', '--reps', '0'], '--reps must be a positive integer'],
    [['run', '--concurrency', 'many'], '--concurrency must be a positive integer'],
    [['verify', 'a'], 'verify takes no skill names'],
  ])('%j exits 2', async (argv, message) => {
    const { code, stderr } = await cli(...argv);

    expect(code).toBe(2);
    expect(stderr).toContain(message);
    expect(stderr).toContain('skill-be --help');
  });

  it('exits 2 when the config file is missing', async () => {
    const { code, stderr } = await cli('verify', '--config', 'nowhere.yaml');

    expect(code).toBe(2);
    expect(stderr).toContain(path.join(root, 'nowhere.yaml'));
    expect(stderr).toContain('cannot read the config file');
  });
});
