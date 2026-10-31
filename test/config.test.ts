import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, typescriptInstalled } from '../src/config.js';
import { ConfigError } from '../src/types.js';

const SKILLS = 'skills: ./skills\nevals: ./evals\n';
const MODEL = 'model:\n  adapter: claude-cli\n  id: claude-sonnet-5-5\n';
const GRADER = 'grader:\n  adapter: claude-cli\n  id: claude-haiku-5-5\n';
const MINIMAL = SKILLS + MODEL + GRADER;

// The default template as written in the design, kept as an independent literal.
const SPEC_TEMPLATE = [
  'You have access to the following library. Use its APIs when writing the code.',
  '',
  '--- LIBRARY DOCS ---',
  '{{skill}}',
  '--- END LIBRARY DOCS ---',
  '',
  'Task: {{task}}',
].join('\n');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'skill-be-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(yaml: string, name = 'skill-be.yaml'): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, yaml);
  return file;
}

async function failure(yaml: string): Promise<ConfigError> {
  const error = await loadConfig(await write(yaml), { typescriptInstalled: () => true }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConfigError);
  return error as ConfigError;
}

describe('loadConfig defaults', () => {
  it('fills every default for the minimal config', async () => {
    const file = await write(MINIMAL);

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config).toEqual({
      root: dir,
      configPath: file,
      skills: path.join(dir, 'skills'),
      evals: path.join(dir, 'evals'),
      models: [{ adapter: 'claude-cli', id: 'claude-sonnet-5-5' }],
      grader: { adapter: 'claude-cli', id: 'claude-haiku-5-5' },
      reps: 3,
      gradings: 3,
      concurrency: 4,
      timeoutSeconds: 120,
      results: path.join(dir, '.skill-be', 'results'),
      resultFile: path.join(dir, 'skill-be.result.json'),
      withSkillTemplate: SPEC_TEMPLATE,
      graderPrompt: null,
      gate: { regressionOnCritical: true, blockOnZero: true, blockOnErrors: true },
      checks: { typecheck: { preset: 'typescript', blocking: true }, coverage: false },
      triage: { model: null },
    });
  });

  it('makes models a one-element array when model is a single entry', async () => {
    const config = await loadConfig(await write(MINIMAL), { typescriptInstalled: () => true });

    expect(config.models).toHaveLength(1);
  });

  it('resolves paths relative to the config file, not the working directory', async () => {
    const nested = path.join(dir, 'conf');
    await mkdir(nested);
    const file = await write(MINIMAL.replace('./skills', '../shared/skills'), 'conf/skill-be.yaml');

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config.root).toBe(nested);
    expect(config.configPath).toBe(file);
    expect(config.skills).toBe(path.join(dir, 'shared', 'skills'));
    expect(config.evals).toBe(path.join(nested, 'evals'));
    expect(config.resultFile).toBe(path.join(nested, 'skill-be.result.json'));
  });

  it('accepts a config path relative to the working directory', async () => {
    const file = await write(MINIMAL);

    const config = await loadConfig(path.relative(process.cwd(), file), {
      typescriptInstalled: () => true,
    });

    expect(config.root).toBe(dir);
    expect(config.configPath).toBe(file);
  });
});

describe('loadConfig overrides', () => {
  it('honors every default overridden in the YAML', async () => {
    const absoluteResults = path.join(dir, 'elsewhere', 'results');
    const file = await write(
      [
        MINIMAL,
        'reps: 5',
        'gradings: 1',
        'concurrency: 2',
        'timeoutSeconds: 30',
        `results: ${JSON.stringify(absoluteResults)}`,
        'resultFile: ./out/result.json',
        'withSkillTemplate: "Docs: {{skill}}\\nDo: {{task}}"',
        'graderPrompt: "Be strict."',
        'gate:',
        '  regressionOnCritical: false',
        '  blockOnZero: false',
        '  blockOnErrors: false',
        'triage:',
        '  model:',
        '    adapter: pi-cli',
        '    id: some-model',
        '    provider: anthropic',
        '',
      ].join('\n'),
    );

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config.reps).toBe(5);
    expect(config.gradings).toBe(1);
    expect(config.concurrency).toBe(2);
    expect(config.timeoutSeconds).toBe(30);
    expect(config.results).toBe(absoluteResults);
    expect(config.resultFile).toBe(path.join(dir, 'out', 'result.json'));
    expect(config.withSkillTemplate).toBe('Docs: {{skill}}\nDo: {{task}}');
    expect(config.graderPrompt).toBe('Be strict.');
    expect(config.gate).toEqual({
      regressionOnCritical: false,
      blockOnZero: false,
      blockOnErrors: false,
    });
    expect(config.triage.model).toEqual({
      adapter: 'pi-cli',
      id: 'some-model',
      provider: 'anthropic',
    });
  });

  it('yields several models when model is a list', async () => {
    const file = await write(
      SKILLS +
        [
          'model:',
          '  - adapter: claude-cli',
          '    id: claude-sonnet-5-5',
          '  - adapter: pi-cli',
          '    id: gpt-x',
          '    provider: openai',
          '',
        ].join('\n') +
        GRADER,
    );

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config.models).toEqual([
      { adapter: 'claude-cli', id: 'claude-sonnet-5-5' },
      { adapter: 'pi-cli', id: 'gpt-x', provider: 'openai' },
    ]);
  });

  it('keeps the adapter settings of an entry, including unknown keys', async () => {
    const file = await write(
      SKILLS +
        [
          'model:',
          '  adapter: command',
          '  id: my-agent',
          '  run: node agent.mjs --fast',
          '  apiKeyEnv: MY_KEY',
          '  args: [--a, --b]',
          '  somethingOnlyMyAdapterKnows: true',
          '',
        ].join('\n') +
        GRADER,
    );

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config.models[0]).toEqual({
      adapter: 'command',
      id: 'my-agent',
      run: 'node agent.mjs --fast',
      apiKeyEnv: 'MY_KEY',
      args: ['--a', '--b'],
      somethingOnlyMyAdapterKnows: true,
    });
  });

  it('keeps unknown keys of the grader and triage.model entries', async () => {
    const file = await write(
      SKILLS +
        MODEL +
        'grader:\n  adapter: pi-cli\n  id: g\n  provider: anthropic\n' +
        'triage:\n  model:\n    adapter: ./mine.mjs\n    id: t\n    temperature: 0\n',
    );

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config.grader).toEqual({ adapter: 'pi-cli', id: 'g', provider: 'anthropic' });
    expect(config.triage.model).toEqual({ adapter: './mine.mjs', id: 't', temperature: 0 });
  });
});

describe('loadConfig checks', () => {
  it('turns the typecheck on by default when typescript resolves', async () => {
    const file = await write(MINIMAL);
    const resolver = vi.fn(() => true);

    const config = await loadConfig(file, { typescriptInstalled: resolver });

    expect(config.checks.typecheck).toEqual({ preset: 'typescript', blocking: true });
    expect(resolver).toHaveBeenCalledWith(dir);
  });

  it('turns the typecheck off by default when typescript does not resolve', async () => {
    const config = await loadConfig(await write(MINIMAL), { typescriptInstalled: () => false });

    expect(config.checks.typecheck).toBe(false);
  });

  it('leaves the coverage off by default', async () => {
    const config = await loadConfig(await write(MINIMAL), { typescriptInstalled: () => true });

    expect(config.checks.coverage).toBe(false);
  });

  it('honors checks.typecheck: false even when typescript resolves', async () => {
    const file = await write(MINIMAL + 'checks:\n  typecheck: false\n');

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config.checks.typecheck).toBe(false);
  });

  it('implies the typescript preset when a typecheck has a library but no preset', async () => {
    const file = await write(
      MINIMAL +
        [
          'checks:',
          '  typecheck:',
          '    library: ../mini-fp/src/index.ts',
          '    blocking: false',
          '    preludes:',
          '      option: ./preludes/option.d.ts',
          '',
        ].join('\n'),
    );

    const config = await loadConfig(file, { typescriptInstalled: () => false });

    expect(config.checks.typecheck).toEqual({
      preset: 'typescript',
      library: '../mini-fp/src/index.ts',
      blocking: false,
      preludes: { option: './preludes/option.d.ts' },
    });
  });

  it('takes a typecheck command as given, without adding the preset', async () => {
    const file = await write(
      MINIMAL + 'checks:\n  typecheck:\n    command: python check_block.py\n',
    );

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config.checks.typecheck).toEqual({ command: 'python check_block.py', blocking: true });
  });

  it('reads a configured coverage check, non-blocking by default', async () => {
    const file = await write(
      MINIMAL +
        [
          'checks:',
          '  coverage:',
          '    entry: ../mini-fp/src/index.ts',
          '    ignore: [internalHelper, Foo.bar]',
          '',
        ].join('\n'),
    );

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config.checks.coverage).toEqual({
      preset: 'typescript',
      entry: '../mini-fp/src/index.ts',
      ignore: ['internalHelper', 'Foo.bar'],
      blocking: false,
    });
  });

  it('reads a coverage command with blocking on', async () => {
    const file = await write(
      MINIMAL + 'checks:\n  coverage:\n    command: python list_api.py\n    blocking: true\n',
    );

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config.checks.coverage).toEqual({
      command: 'python list_api.py',
      ignore: [],
      blocking: true,
    });
  });
});

describe('loadConfig errors', () => {
  const cases: [string, string, RegExp][] = [
    ['a missing model', SKILLS + GRADER, /"model"/],
    ['a missing grader', SKILLS + MODEL, /"grader"/],
    ['a missing skills key', 'evals: ./evals\n' + MODEL + GRADER, /"skills"/],
    ['a missing evals key', 'skills: ./skills\n' + MODEL + GRADER, /"evals"/],
    ['an unknown top-level key', MINIMAL + 'modle: oops\n', /"modle"/],
    [
      'an unknown key in gate',
      MINIMAL + 'gate:\n  blockOnZeros: false\n',
      /unknown key "gate\.blockOnZeros".*blockOnZero/,
    ],
    [
      'an unknown key in checks',
      MINIMAL + 'checks:\n  typecheks: false\n',
      /unknown key "checks\.typecheks".*typecheck, coverage/,
    ],
    [
      'an unknown key in checks.typecheck',
      MINIMAL + 'checks:\n  typecheck:\n    libary: ./src/index.ts\n',
      /unknown key "checks\.typecheck\.libary".*library/,
    ],
    [
      'an unknown key in checks.coverage',
      MINIMAL + 'checks:\n  coverage:\n    entry: a.ts\n    bloking: true\n',
      /unknown key "checks\.coverage\.bloking".*blocking/,
    ],
    [
      'an unknown key in triage',
      MINIMAL + 'triage:\n  modle:\n    adapter: claude-cli\n    id: x\n',
      /unknown key "triage\.modle".*model/,
    ],
    ['reps: 0', MINIMAL + 'reps: 0\n', /"reps"/],
    ['a fractional reps', MINIMAL + 'reps: 1.5\n', /"reps"/],
    ['a string reps', MINIMAL + 'reps: "3"\n', /"reps"/],
    ['gradings: 0', MINIMAL + 'gradings: 0\n', /"gradings"/],
    ['a negative concurrency', MINIMAL + 'concurrency: -1\n', /"concurrency"/],
    ['timeoutSeconds: 0', MINIMAL + 'timeoutSeconds: 0\n', /"timeoutSeconds"/],
    [
      'a timeoutSeconds a timer cannot hold',
      MINIMAL + 'timeoutSeconds: 2147484\n',
      /"timeoutSeconds" must be at most 2147483 .*\(got 2147484\)/,
    ],
    ['an empty model list', SKILLS + 'model: []\n' + GRADER, /"model"/],
    [
      'a model entry without an id',
      SKILLS + 'model:\n  - adapter: claude-cli\n' + GRADER,
      /"model\[0\]\.id"/,
    ],
    [
      'a model entry without an adapter',
      SKILLS + 'model:\n  id: claude-sonnet-5-5\n' + GRADER,
      /"model\.adapter"/,
    ],
    [
      'a grader given as a list',
      SKILLS + MODEL + 'grader:\n  - adapter: claude-cli\n    id: haiku\n',
      /"grader"/,
    ],
    ['a non-boolean gate flag', MINIMAL + 'gate:\n  blockOnZero: "yes"\n', /"gate\.blockOnZero"/],
    [
      'a template without {{task}}',
      MINIMAL + 'withSkillTemplate: "Docs: {{skill}}"\n',
      /"withSkillTemplate".*\{\{task\}\}/,
    ],
    [
      'a template without {{skill}}',
      MINIMAL + 'withSkillTemplate: "Do: {{task}}"\n',
      /"withSkillTemplate".*\{\{skill\}\}/,
    ],
    [
      'an unknown typecheck preset',
      MINIMAL + 'checks:\n  typecheck:\n    preset: python\n',
      /"checks\.typecheck\.preset"/,
    ],
    [
      'a typecheck that is neither false nor a mapping',
      MINIMAL + 'checks:\n  typecheck: yes-please\n',
      /"checks\.typecheck"/,
    ],
    [
      'a non-list coverage ignore',
      MINIMAL + 'checks:\n  coverage:\n    entry: a.ts\n    ignore: Foo\n',
      /"checks\.coverage\.ignore"/,
    ],
    ['a config that is not a mapping', '- just\n- a list\n', /mapping/],
    ['an empty file', '', /"skills"/],
    ['broken YAML', 'skills: [unclosed\n', /YAML/i],
  ];

  it.each(cases)('rejects %s with a message naming the problem', async (_name, yaml, pattern) => {
    const error = await failure(yaml);

    expect(error.message).toMatch(pattern);
  });

  it('accepts the largest timeoutSeconds a timer can hold', async () => {
    const file = await write(MINIMAL + 'timeoutSeconds: 2147483\n');

    const config = await loadConfig(file, { typescriptInstalled: () => true });

    expect(config.timeoutSeconds).toBe(2147483);
  });

  it('names the config file in the message', async () => {
    const error = await failure(SKILLS + GRADER);

    expect(error.message).toContain(path.join(dir, 'skill-be.yaml'));
  });

  it('rejects a config file that does not exist', async () => {
    const error = await loadConfig(path.join(dir, 'nope.yaml')).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('nope.yaml');
  });
});

describe('typescriptInstalled', () => {
  it('finds typescript from the project root', () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));

    expect(typescriptInstalled(repoRoot)).toBe(true);
  });

  it("falls back to skill-be's own install for a root with no node_modules", () => {
    expect(typescriptInstalled(dir)).toBe(true);
  });
});
