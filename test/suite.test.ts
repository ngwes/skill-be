import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadSuites } from '../src/suite.js';
import { ConfigError } from '../src/types.js';

const CONFIG_YAML =
  'skills: ./skills\nevals: ./evals\nmodel:\n  adapter: command\n  id: fake\n' +
  'grader:\n  adapter: command\n  id: fake\n';

function fixtureConfig(name: string) {
  const file = fileURLToPath(new URL(`./fixtures/${name}/skillbe.yaml`, import.meta.url));
  return loadConfig(file);
}

describe('loadSuites', () => {
  it('returns the suite of a skill with an eval file and warns about one without', async () => {
    const config = await fixtureConfig('suite');

    const { suites, warnings } = await loadSuites(config);

    expect(suites).toHaveLength(1);
    const suite = suites[0]!;
    expect(suite.name).toBe('a');
    expect(suite.skillPath).toBe(path.join(config.skills, 'a', 'SKILL.md'));
    expect(suite.evalPath).toBe(path.join(config.evals, 'a.json'));
    expect(suite.skillText).toContain('# Skill A');
    expect(suite.skillText).toBe(await readFile(suite.skillPath, 'utf8'));
    expect(suite.scenarios).toEqual([
      {
        id: 'double-a-number',
        critical: true,
        prompt: 'Write a TypeScript function that returns twice the value it is given.',
        criteria: ['Calls double() instead of multiplying', 'Returns a number'],
      },
      {
        id: 'double-a-list',
        critical: false,
        prompt: 'Write a TypeScript function that doubles every number in a list.',
        criteria: ['Maps the list with double()'],
      },
    ]);
    expect(warnings).toEqual(['skill "b" has no eval file']);
  });

  it('keeps only the named skills', async () => {
    const config = await fixtureConfig('suite');

    const { suites, warnings } = await loadSuites(config, ['a']);

    expect(suites.map((s) => s.name)).toEqual(['a']);
    expect(warnings).toEqual([]);
  });

  it('warns and skips a named skill that has no eval file', async () => {
    const config = await fixtureConfig('suite');

    const { suites, warnings } = await loadSuites(config, ['b']);

    expect(suites).toEqual([]);
    expect(warnings).toEqual(['skill "b" has no eval file']);
  });

  it('treats an empty list of names as every skill', async () => {
    const config = await fixtureConfig('suite');

    const { suites } = await loadSuites(config, []);

    expect(suites.map((s) => s.name)).toEqual(['a']);
  });

  it('rejects a name that is not a skill', async () => {
    const config = await fixtureConfig('suite');

    const error = await loadSuites(config, ['a', 'zzz']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('"zzz"');
    expect((error as ConfigError).message).toContain('a, b');
  });

  it('loads a real eval file from mini-fp-skills', async () => {
    const config = await fixtureConfig('suite-real');

    const { suites, warnings } = await loadSuites(config);

    expect(warnings).toEqual([]);
    expect(suites).toHaveLength(1);
    const suite = suites[0]!;
    expect(suite.name).toBe('option');
    expect(suite.scenarios.map((s) => [s.id, s.critical, s.criteria.length])).toEqual([
      ['nullable-lookup', true, 3],
      ['chain-optional-steps', true, 3],
      ['async-nullable-noisy-context', false, 3],
      ['theme-fallback-chain', true, 3],
      ['cache-then-db-to-either', false, 3],
      ['loyalty-tier-guards-noisy', false, 3],
    ]);
    expect(suite.scenarios[0]!.prompt).toContain('looks up a user by ID');
    expect(suite.scenarios[0]!.criteria[0]).toContain('Option.from()');
  });
});

describe('loadSuites on malformed projects', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'skillbe-suite-'));
    await mkdir(path.join(dir, 'skills', 'x'), { recursive: true });
    await mkdir(path.join(dir, 'evals'));
    await writeFile(path.join(dir, 'skills', 'x', 'SKILL.md'), '# X\n');
    await writeFile(path.join(dir, 'skillbe.yaml'), CONFIG_YAML);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function loadWithEval(content: string) {
    await writeFile(path.join(dir, 'evals', 'x.json'), content);
    return loadSuites(await loadConfig(path.join(dir, 'skillbe.yaml')));
  }

  async function failureFor(content: string): Promise<ConfigError> {
    const error = await loadWithEval(content).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }

  const scenario = (extra: Record<string, unknown> = {}) => ({
    id: 'one',
    critical: false,
    prompt: 'Do the thing.',
    criteria: ['It is done'],
    ...extra,
  });

  it('rejects a scenario without criteria, naming the file and the scenario', async () => {
    const { criteria: _omitted, ...withoutCriteria } = scenario({ id: 'no-criteria' });

    const error = await failureFor(JSON.stringify({ skill: 'x', scenarios: [withoutCriteria] }));

    expect(error.message).toContain('x.json');
    expect(error.message).toContain('"no-criteria"');
    expect(error.message).toContain('criteria');
  });

  it('rejects a duplicate scenario id, naming the file and the scenario', async () => {
    const error = await failureFor(
      JSON.stringify({
        skill: 'x',
        scenarios: [scenario({ id: 'same' }), scenario({ id: 'other' }), scenario({ id: 'same' })],
      }),
    );

    expect(error.message).toContain('x.json');
    expect(error.message).toContain('"same"');
    expect(error.message).toMatch(/duplicate/i);
  });

  it.each([
    ['an empty criteria list', { criteria: [] }, 'criteria'],
    ['a non-string criterion', { criteria: ['fine', 3] }, 'criteria'],
    ['an empty criterion', { criteria: ['  '] }, 'criteria'],
    ['a missing prompt', { prompt: undefined }, 'prompt'],
    ['an empty prompt', { prompt: '' }, 'prompt'],
    ['a non-boolean critical', { critical: 'yes' }, 'critical'],
    ['a missing id', { id: undefined }, 'id'],
  ])('rejects %s', async (_name, extra, key) => {
    const error = await failureFor(JSON.stringify({ skill: 'x', scenarios: [scenario(extra)] }));

    expect(error.message).toContain('x.json');
    expect(error.message).toContain(`"${key}"`);
  });

  it('treats a scenario without critical as not critical', async () => {
    const { critical: _omitted, ...withoutCritical } = scenario();

    const { suites } = await loadWithEval(
      JSON.stringify({ skill: 'x', scenarios: [withoutCritical] }),
    );

    expect(suites[0]!.scenarios[0]!.critical).toBe(false);
  });

  it.each([
    ['no scenarios key', { skill: 'x' }],
    ['an empty scenarios list', { skill: 'x', scenarios: [] }],
    ['a scenarios value that is not a list', { skill: 'x', scenarios: {} }],
    ['a scenario that is not an object', { skill: 'x', scenarios: ['nope'] }],
  ])('rejects an eval file with %s', async (_name, content) => {
    const error = await failureFor(JSON.stringify(content));

    expect(error.message).toContain('x.json');
    expect(error.message).toContain('scenarios');
  });

  it('rejects an eval file that is not valid JSON', async () => {
    const error = await failureFor('{ "scenarios": [ ');

    expect(error.message).toContain('x.json');
  });

  it('reads an eval file saved with a byte order mark', async () => {
    const { suites } = await loadWithEval('﻿' + JSON.stringify({ scenarios: [scenario()] }));

    expect(suites[0]!.scenarios.map((s) => s.id)).toEqual(['one']);
  });

  it('ignores folders without a SKILL.md and stray files in the skills directory', async () => {
    await mkdir(path.join(dir, 'skills', 'shared-assets'));
    await writeFile(path.join(dir, 'skills', 'README.md'), 'not a skill\n');
    await writeFile(
      path.join(dir, 'evals', 'x.json'),
      JSON.stringify({ skill: 'x', scenarios: [scenario()] }),
    );

    const { suites, warnings } = await loadSuites(await loadConfig(path.join(dir, 'skillbe.yaml')));

    expect(suites.map((s) => s.name)).toEqual(['x']);
    expect(warnings).toEqual([]);
  });

  it('rejects a skills directory that does not exist', async () => {
    await rm(path.join(dir, 'skills'), { recursive: true });

    const error = await loadSuites(await loadConfig(path.join(dir, 'skillbe.yaml'))).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('skills');
  });
});
