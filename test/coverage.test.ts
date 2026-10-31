import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coverage, validateCoverage, type CoverageDeps } from '../src/checks/coverage.js';
import { ConfigError, type CoverageConfig, type SkillSuite } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/typecheck/', import.meta.url));
const PRESET: CoverageConfig = {
  preset: 'typescript',
  entry: './lib/index.ts',
  ignore: [],
  blocking: false,
};

/** The fixture library's public API: its exports and the public members of its classes. */
const API = [
  'Box',
  'Box.map',
  'Box.size',
  'Box.value',
  'Mapper',
  'Option',
  'Option.get',
  'Option.of',
  'Option.value',
  'box',
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'skillbe-coverage-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A skill with the given SKILL.md text and eval file text. */
async function skill(
  skillText: string,
  evalText = '{ "scenarios": [] }',
  name = 'box',
): Promise<SkillSuite> {
  const evalPath = path.join(dir, `${name}.json`);
  await writeFile(evalPath, evalText);
  return { name, skillPath: path.join(dir, name, 'SKILL.md'), skillText, evalPath, scenarios: [] };
}

async function missingIn(
  suites: SkillSuite[],
  cfg: Partial<CoverageConfig> = {},
): Promise<string[]> {
  return (await coverage(suites, { ...PRESET, ...cfg }, FIXTURES)).missing;
}

/** The error `coverage` throws for a skill with nothing in it. */
async function failureOf(cfg: CoverageConfig, deps?: CoverageDeps): Promise<unknown> {
  return coverage([await skill('')], cfg, FIXTURES, deps).catch((caught: unknown) => caught);
}

describe('coverage with the typescript preset', () => {
  it('lists the exports and the public members of exported classes as Class.member', async () => {
    const missing = await missingIn([await skill('# Nothing here')]);

    expect(missing).toEqual(API);
  });

  it('leaves out constructors and private, protected and #private members', async () => {
    const missing = await missingIn([await skill('# Nothing here')]);

    for (const name of ['Box.constructor', 'Box.cache', 'Box.log', 'Box.#secret']) {
      expect(missing).not.toContain(name);
    }
    expect(missing.some((name) => name.startsWith('Option.constructor'))).toBe(false);
  });

  it('counts a name as mentioned as a whole word in a SKILL.md', async () => {
    const text = 'Wrap a number with `box(1)`, typed as (Box<number>) and Mapper.';

    const missing = await missingIn([await skill(text)]);

    expect(missing).toEqual(API.filter((name) => !['Box', 'Mapper', 'box'].includes(name)));
  });

  it('does not count a name that is only part of a longer word', async () => {
    const text = 'boxes unbox() Mapper2 _Option $Option Optional values sizes';

    const missing = await missingIn([await skill(text)]);

    expect(missing).toEqual(API);
  });

  it('is case sensitive', async () => {
    const missing = await missingIn([await skill('option BOX MAPPER')]);

    expect(missing).toEqual(API);
  });

  it('counts a member by its member name', async () => {
    const missing = await missingIn([await skill('Call `.map(...)` and then `.get()`.')]);

    expect(missing).not.toContain('Box.map');
    expect(missing).not.toContain('Option.get');
    expect(missing).toContain('Box.size');
  });

  it('counts a mention in the eval file of any of the suites', async () => {
    const first = await skill('# First', '{ "scenarios": [{ "prompt": "Use Option.of" }] }', 'a');
    // In the JSON text, the line break reads \n and glues to the word after it.
    const escaped = '{ "scenarios": [{ "prompt": "Write:\\nMapper" }] }';
    const second = await skill('# Second', escaped, 'b');

    const missing = await missingIn([first, second]);

    const mentioned = ['Option', 'Option.of', 'Mapper'];
    expect(missing).toEqual(API.filter((name) => !mentioned.includes(name)));
  });

  it('counts a mention in a SKILL.md of any of the suites', async () => {
    const suites = [await skill('# One\nsize', undefined, 'one'), await skill('Box', '', 'two')];

    const missing = await missingIn(suites);

    expect(missing).not.toContain('Box.size');
    expect(missing).not.toContain('Box');
  });

  it('reports nothing when every name is mentioned', async () => {
    const text = 'Box map size value Mapper Option get of box';

    const result = await coverage([await skill(text)], { ...PRESET, blocking: true }, FIXTURES);

    expect(result).toEqual({ missing: [], blocking: true });
  });

  it('removes the ignored names, a Class.member name included', async () => {
    const ignore = ['Box', 'Box.value', 'Option.value', 'box', 'NotAnExport'];

    const missing = await missingIn([await skill('# Nothing here')], { ignore });

    expect(missing).toEqual(
      API.filter((name) => !['Box', 'Box.value', 'Option.value', 'box'].includes(name)),
    );
  });

  it('warns by default and blocks only when blocking is on', async () => {
    const suites = [await skill('# Nothing here')];

    const warning = await coverage(suites, PRESET, FIXTURES);
    const blocking = await coverage(suites, { ...PRESET, blocking: true }, FIXTURES);

    expect(warning.blocking).toBe(false);
    expect(blocking.blocking).toBe(true);
    expect(blocking.missing).toEqual(warning.missing);
  });

  it('resolves the entry against the root', async () => {
    const suites = [await skill('# Nothing here')];

    const cfg = { ...PRESET, entry: 'index.ts' };

    const result = await coverage(suites, cfg, path.join(FIXTURES, 'lib'));

    expect(result.missing).toEqual(API);
  });

  it('fails with a clear error when the preset has no entry', async () => {
    const cfg: CoverageConfig = { preset: 'typescript', ignore: [], blocking: false };

    const error = await failureOf(cfg);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('checks.coverage.entry');
  });

  it('fails with a clear error when the entry does not exist', async () => {
    const cfg = { ...PRESET, entry: './lib/nowhere.ts' };

    const error = await failureOf(cfg);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('nowhere.ts');
  });

  it('fails with a clear error when typescript is not installed', async () => {
    const missing = () => Promise.reject(new Error("Cannot find package 'typescript'"));

    const error = await failureOf(PRESET, { loadTypescript: missing });

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('npm install --save-dev typescript');
  });
});

describe('coverage with a command', () => {
  const lister = path.join(FIXTURES, 'list-api.mjs');
  const command = (...names: string[]): string =>
    [`"${process.execPath}"`, `"${lister}"`, ...names].join(' ');

  it('reads the names the command prints, one per line, instead of using the preset', async () => {
    // The config still names an entry; the command replaces the preset.
    const cfg: CoverageConfig = {
      ...PRESET,
      command: command('fetchUser', 'Account.close', 'ghost', 'ghost'),
      blocking: true,
    };
    const text = 'Use `fetchUser`, then Account.close() and never ghosts.';

    const result = await coverage([await skill(text)], cfg, FIXTURES);

    expect(result).toEqual({ missing: ['ghost'], blocking: true });
  });

  it('removes the ignored names', async () => {
    const cfg: CoverageConfig = {
      ignore: ['ghost'],
      command: command('fetchUser', 'ghost'),
      blocking: false,
    };

    const result = await coverage([await skill('# Nothing here')], cfg, FIXTURES);

    expect(result.missing).toEqual(['fetchUser']);
  });

  it('fails with the command output when the command exits non-zero', async () => {
    const cfg: CoverageConfig = { ignore: [], command: command('--fail'), blocking: false };

    const error = await failureOf(cfg);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('exit code 3');
    expect((error as Error).message).toContain('cannot list the API');
  });

  it('fails with a clear error when the command cannot be started', async () => {
    const cfg: CoverageConfig = {
      ignore: [],
      command: 'skillbe-no-such-command --list',
      blocking: false,
    };

    const error = await failureOf(cfg);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('failed to start');
  });

  it('fails with a clear error when the command line is empty', async () => {
    const cfg: CoverageConfig = { ignore: [], command: '  ', blocking: false };

    const error = await failureOf(cfg);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('checks.coverage.command');
  });
});

// Runs against a local checkout of mini-fp-skills (SKILLBE_SKILLS_REPO, its root) and the
// mini-fp source entry its skills document (SKILLBE_MINI_FP_ENTRY); skipped without both.
const SKILLS_REPO = process.env.SKILLBE_SKILLS_REPO;
const MINI_FP_ENTRY = process.env.SKILLBE_MINI_FP_ENTRY;

describe.runIf(Boolean(SKILLS_REPO && MINI_FP_ENTRY))('the mini-fp-skills coverage', () => {
  const REPO = SKILLS_REPO ?? '';
  const ENTRY = MINI_FP_ENTRY ?? '';
  const NAMES = [
    'async-pipelines',
    'either',
    'error-handling',
    'mini-fp',
    'option',
    'try',
    'utils',
    'validate',
    'validation-patterns',
  ];

  it('reports the names no skill or eval mentions', { timeout: 120_000 }, async () => {
    const suites: SkillSuite[] = [];
    for (const name of NAMES) {
      const skillPath = path.join(REPO, 'skills', name, 'SKILL.md');
      const skillText = await readFile(skillPath, 'utf8');
      const evalPath = path.join(REPO, 'evals', `${name}.json`);
      suites.push({ name, skillPath, skillText, evalPath, scenarios: [] });
    }
    const cfg: CoverageConfig = { preset: 'typescript', entry: ENTRY, ignore: [], blocking: false };

    const result = await coverage(suites, cfg, REPO);

    console.log(`missing (${result.missing.length}):\n${result.missing.join('\n')}`);
    expect(result.blocking).toBe(false);
    // The core types are documented, whatever else is missing.
    for (const name of ['Option', 'Either', 'Try', 'Validate']) {
      expect(result.missing).not.toContain(name);
    }
  });
});

describe('validateCoverage', () => {
  const failureOf = (cfg: CoverageConfig): Promise<unknown> =>
    validateCoverage(cfg, FIXTURES).then(
      () => undefined,
      (caught: unknown) => caught,
    );

  it('accepts a preset whose entry resolves', async () => {
    await expect(validateCoverage(PRESET, FIXTURES)).resolves.toBeUndefined();
  });

  it('accepts a command without running it', async () => {
    const cfg: CoverageConfig = { ignore: [], command: 'skillbe-no-such-binary', blocking: false };

    await expect(validateCoverage(cfg, FIXTURES)).resolves.toBeUndefined();
  });

  it.each([
    ['no entry', { preset: 'typescript', ignore: [], blocking: false }, 'checks.coverage.entry'],
    ['an entry that does not exist', { ...PRESET, entry: './lib/nowhere.ts' }, 'nowhere.ts'],
    [
      'a command with an unclosed quote',
      { ignore: [], command: 'node "list', blocking: false },
      'unclosed quote',
    ],
    ['an empty command', { ignore: [], command: '  ', blocking: false }, 'checks.coverage.command'],
  ])('throws a ConfigError for %s', async (_, cfg: CoverageConfig, message) => {
    const error = await failureOf(cfg);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(message);
  });
});
