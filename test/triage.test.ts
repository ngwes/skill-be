import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterError, type Adapter, type AdapterContext } from '../src/adapters/index.js';
import { buildGraderPrompt } from '../src/grader.js';
import type { RunSummary, ScenarioSummary, SkillSummary } from '../src/report.js';
import { parseClassification, triage } from '../src/triage.js';
import {
  ConfigError,
  type AdapterSettings,
  type Config,
  type Scenario,
  type SkillSuite,
} from '../src/types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'skill-be-triage-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const MODEL: AdapterSettings = { adapter: 'fake', id: 'm1' };
const GRADER: AdapterSettings = { adapter: 'fake', id: 'grader' };
const TRIAGER: AdapterSettings = { adapter: 'fake', id: 'triager' };

const RUN = '2026-10-31T09-05-03-042Z';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    root,
    configPath: path.join(root, 'skill-be.yaml'),
    skills: path.join(root, 'skills'),
    evals: path.join(root, 'evals'),
    models: [MODEL],
    grader: GRADER,
    reps: 3,
    gradings: 1,
    concurrency: 4,
    timeoutSeconds: 120,
    results: path.join(root, 'results'),
    resultFile: path.join(root, 'skill-be.result.json'),
    withSkillTemplate: 'SKILL<{{skill}}>\nTASK<{{task}}>',
    graderPrompt: null,
    gate: { regressionOnCritical: true, blockOnZero: true, blockOnErrors: true },
    checks: { typecheck: false, coverage: false },
    triage: { model: TRIAGER },
    ...overrides,
  };
}

const scenario = (id: string, criteria = ['c1', 'c2']): Scenario => ({
  id,
  critical: true,
  prompt: `Task for ${id}`,
  criteria,
});

function makeSuite(name = 'demo', scenarios: Scenario[] = [scenario('s1')]): SkillSuite {
  return {
    name,
    skillPath: path.join(root, 'skills', name, 'SKILL.md'),
    skillText: `the ${name} skill`,
    evalPath: path.join(root, 'evals', `${name}.json`),
    scenarios,
  };
}

/** A summary scenario where every model scores `scores[c]` = [baseline, with skill]. */
function summaryScenario(
  s: Scenario,
  models: Record<string, Array<[number, number]>>,
): ScenarioSummary {
  return {
    id: s.id,
    critical: s.critical,
    prompt: s.prompt,
    criteria: [...s.criteria],
    models: Object.entries(models).map(([model, scores]) => ({
      model,
      criteria: scores.map(([baselinePct, withSkillPct]) => ({ baselinePct, withSkillPct })),
      notes: [],
    })),
  };
}

function skillSummary(
  skill: string,
  scenarios: ScenarioSummary[],
  blocks: SkillSummary['blocks'] = [],
): SkillSummary {
  return {
    skill,
    startedAt: '2026-10-31T09:05:03.042Z',
    durationMs: 1000,
    errorCount: blocks.some((b) => b.kind === 'error') ? 2 : 0,
    ready: blocks.length === 0,
    reasons: blocks.map((b) => `reason for ${b.kind}`),
    blocks,
    scenarios,
  };
}

async function writeSummary(summary: RunSummary, timestamp = RUN): Promise<string> {
  const dir = path.join(root, 'results', timestamp);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return dir;
}

/** The answer the grader adapter received, taken from the `<answer>` fence. */
function answerIn(prompt: string): string {
  const match = /<answer>\n([\s\S]*?)\n<\/answer>/.exec(prompt);
  if (!match?.[1]) throw new Error('no <answer> in the prompt');
  return match[1];
}

const graderReply = (values: boolean[], reasons = 'Reason: the code uses map.'): string =>
  `${reasons}\nVERDICTS:\n${values.map((v, i) => `${i + 1}: ${v ? 'YES' : 'NO'}`).join('\n')}`;

const CLASSIFIED = 'Looking at it.\nCLASSIFICATION: grader error\nREASON: the code calls map.';

type Calls = { model: string[]; grader: string[]; triager: string[] };
type Deps = NonNullable<NonNullable<Parameters<typeof triage>[2]>['deps']>;

/** Fake adapters for the model under test, the grader and the triage model, recording prompts. */
function fakes(
  over: { model?: Adapter; grader?: Adapter; triager?: Adapter } = {},
): { deps: Deps; calls: Calls; contexts: AdapterContext[] } {
  const calls: Calls = { model: [], grader: [], triager: [] };
  const contexts: AdapterContext[] = [];
  let n = 0;
  const model: Adapter = over.model ?? (async () => `code sample ${++n}`);
  const grader: Adapter = over.grader ?? (async () => graderReply([false, true]));
  const triager: Adapter = over.triager ?? (async () => CLASSIFIED);
  const record =
    (kind: keyof Calls, adapter: Adapter): Adapter =>
    async (prompt, ctx) => {
      calls[kind].push(prompt);
      contexts.push(ctx);
      return adapter(prompt, ctx);
    };
  return {
    calls,
    contexts,
    deps: {
      adapterFor: async (settings) => {
        if (settings === GRADER) return record('grader', grader);
        if (settings === TRIAGER) return record('triager', triager);
        return record('model', model);
      },
      log: () => {},
      timestamp: '2026-10-31T10-00-00-000Z',
    },
  };
}

const pick = (items: Awaited<ReturnType<typeof triage>>['items']) =>
  items.map(({ skill, scenario, criterion, model }) => ({ skill, scenario, criterion, model }));

describe('triage selection', () => {
  it('triages the criteria of zero and regression blocks, skipping error blocks', async () => {
    const s1 = scenario('s1', ['c1', 'c2', 'c3']);
    await writeSummary({
      skills: [
        skillSummary(
          'demo',
          [summaryScenario(s1, { m1: [[0, 0], [100, 33], [100, 100]] })],
          [
            { kind: 'error' },
            { kind: 'zero', scenario: 's1', criterion: 0 },
            { kind: 'regression', scenario: 's1', criterion: 1, model: 'm1' },
          ],
        ),
      ],
    });
    const { deps } = fakes();

    const result = await triage(makeConfig(), [makeSuite('demo', [s1])], { deps });

    expect(pick(result.items)).toEqual([
      { skill: 'demo', scenario: 's1', criterion: 'c1', model: 'm1' },
      { skill: 'demo', scenario: 's1', criterion: 'c2', model: 'm1' },
    ]);
    const report = await readFile(result.reportPath, 'utf8');
    expect(report).toMatch(/demo.*error block.*not triaged/i);
    expect(report).toContain('Why: blocked (universal 0%).');
    expect(report).toContain('Why: blocked (regression). In the run: baseline 100%, with skill 33%.');
  });

  it('triages a zero block on every model under test', async () => {
    const config = makeConfig({ models: [MODEL, { adapter: 'fake', id: 'm2' }] });
    await writeSummary({
      skills: [
        skillSummary(
          'demo',
          [summaryScenario(scenario('s1'), { m1: [[0, 0], [0, 100]], m2: [[0, 0], [0, 50]] })],
          [{ kind: 'zero', scenario: 's1', criterion: 0 }],
        ),
      ],
    });
    const { deps } = fakes();

    const result = await triage(config, [makeSuite()], { deps });

    expect(pick(result.items)).toEqual([
      { skill: 'demo', scenario: 's1', criterion: 'c1', model: 'm1' },
      { skill: 'demo', scenario: 's1', criterion: 'c1', model: 'm2' },
    ]);
  });

  it('with `below` also triages criteria under that percentage with the skill, once each', async () => {
    const s1 = scenario('s1', ['c1', 'c2', 'c3', 'c4']);
    await writeSummary({
      skills: [
        skillSummary(
          'demo',
          [summaryScenario(s1, { m1: [[0, 0], [0, 49], [0, 50], [0, 100]] })],
          [{ kind: 'zero', scenario: 's1', criterion: 0 }],
        ),
      ],
    });
    const { deps } = fakes();

    const result = await triage(makeConfig(), [makeSuite('demo', [s1])], { below: 50, deps });

    expect(result.items.map((item) => item.criterion)).toEqual(['c1', 'c2']);
  });

  it('only triages the given suites and ignores the other skills of the run', async () => {
    await writeSummary({
      skills: [
        skillSummary('other', [summaryScenario(scenario('s1'), { m1: [[0, 0], [0, 0]] })], [
          { kind: 'zero', scenario: 's1', criterion: 0 },
        ]),
        skillSummary('demo', [summaryScenario(scenario('s1'), { m1: [[0, 100], [0, 0]] })], [
          { kind: 'zero', scenario: 's1', criterion: 1 },
        ]),
      ],
    });
    const { deps } = fakes();

    const result = await triage(makeConfig(), [makeSuite('demo')], { deps });

    expect(pick(result.items)).toEqual([
      { skill: 'demo', scenario: 's1', criterion: 'c2', model: 'm1' },
    ]);
  });

  it('reads the newest run that has a summary.json', async () => {
    const block = (criterion: number): SkillSummary['blocks'] => [
      { kind: 'zero', scenario: 's1', criterion },
    ];
    const scenarios = [summaryScenario(scenario('s1'), { m1: [[0, 0], [0, 0]] })];
    const run = (criterion: number): RunSummary => ({
      skills: [skillSummary('demo', scenarios, block(criterion))],
    });
    await writeSummary(run(0), '2026-10-30T09-00-00-000Z');
    const newest = await writeSummary(run(1), '2026-10-31T08-00-00-000Z');
    // A newer run that never finished has no summary, and a stray folder is not a run.
    await mkdir(path.join(root, 'results', '2026-10-31T09-00-00-000Z'), { recursive: true });
    await mkdir(path.join(root, 'results', 'zzz-notes'), { recursive: true });
    const { deps } = fakes();

    const result = await triage(makeConfig(), [makeSuite()], { deps });

    expect(result.items.map((item) => item.criterion)).toEqual(['c2']);
    expect(result.reportPath).toBe(path.join(newest, 'triage-2026-10-31T10-00-00-000Z.md'));
  });

  it('throws a ConfigError when there is no run to triage', async () => {
    const { deps } = fakes();
    await expect(triage(makeConfig(), [makeSuite()], { deps })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await mkdir(path.join(root, 'results', RUN), { recursive: true });
    await expect(triage(makeConfig(), [makeSuite()], { deps })).rejects.toThrow(/summary\.json/);
  });

  it('writes a report saying so when nothing failed', async () => {
    await writeSummary({
      skills: [
        skillSummary('demo', [summaryScenario(scenario('s1'), { m1: [[0, 100], [0, 100]] })]),
      ],
    });
    const { deps, calls } = fakes();

    const result = await triage(makeConfig(), [makeSuite()], { deps });

    expect(result.items).toEqual([]);
    expect(calls.model).toEqual([]);
    expect(await readFile(result.reportPath, 'utf8')).toMatch(/no failing criteria/i);
  });

  it('skips a criterion the eval no longer has, with a note in the report', async () => {
    await writeSummary({
      skills: [
        skillSummary(
          'demo',
          [summaryScenario(scenario('s1', ['old', 'c2']), { m1: [[0, 0], [0, 100]] })],
          [{ kind: 'zero', scenario: 's1', criterion: 0 }],
        ),
        skillSummary('gone', [summaryScenario(scenario('s9'), { m1: [[0, 0], [0, 100]] })], [
          { kind: 'zero', scenario: 's9', criterion: 0 },
        ]),
      ],
    });
    const { deps, calls } = fakes();

    const result = await triage(makeConfig(), [makeSuite('demo'), makeSuite('gone')], { deps });

    expect(result.items).toEqual([]);
    expect(calls.model).toEqual([]);
    const report = await readFile(result.reportPath, 'utf8');
    expect(report).toContain('"old"');
    expect(report).toContain('s9');
  });

  it('maps a model label back to its config entry the way the runner labels models', async () => {
    const a: AdapterSettings = { adapter: 'a', id: 'same' };
    const b: AdapterSettings = { adapter: 'b', id: 'same' };
    await writeSummary({
      skills: [
        skillSummary(
          'demo',
          [
            summaryScenario(scenario('s1'), {
              'a:same': [[100, 100], [0, 0]],
              'b:same': [[100, 0], [0, 100]],
            }),
          ],
          [{ kind: 'regression', scenario: 's1', criterion: 0, model: 'b:same' }],
        ),
      ],
    });
    const { deps, contexts } = fakes();

    const config = makeConfig({ models: [a, b], triage: { model: null } });
    const result = await triage(config, [makeSuite()], { deps });

    expect(pick(result.items)).toEqual([
      { skill: 'demo', scenario: 's1', criterion: 'c1', model: 'b:same' },
    ]);
    // Two generations by `b:same`, then the classification by that same model under test.
    const modelCalls = contexts.filter((ctx) => ctx.settings !== GRADER);
    expect(modelCalls.map((ctx) => ctx.settings)).toEqual([b, b, b]);
  });

  it('skips a model the config no longer has, with a note in the report', async () => {
    await writeSummary({
      skills: [
        skillSummary('demo', [summaryScenario(scenario('s1'), { gone: [[100, 0], [0, 100]] })], [
          { kind: 'regression', scenario: 's1', criterion: 0, model: 'gone' },
        ]),
      ],
    });
    const { deps, calls } = fakes();

    const result = await triage(makeConfig(), [makeSuite()], { deps });

    expect(result.items).toEqual([]);
    expect(calls.model).toEqual([]);
    expect(await readFile(result.reportPath, 'utf8')).toContain('gone');
  });
});

/** One zero block on criterion 2 of `s1`, as a run of the default suite. */
async function oneFailure(): Promise<string> {
  return writeSummary({
    skills: [
      skillSummary('demo', [summaryScenario(scenario('s1'), { m1: [[0, 100], [67, 0]] })], [
        { kind: 'zero', scenario: 's1', criterion: 1 },
      ]),
    ],
  });
}

describe('triage samples and grading', () => {
  it('generates 2 with-skill samples by default and `samples` when given', async () => {
    await oneFailure();
    const first = fakes();
    await triage(makeConfig(), [makeSuite()], { deps: first.deps });
    expect(first.calls.model).toEqual([
      'SKILL<the demo skill>\nTASK<Task for s1>',
      'SKILL<the demo skill>\nTASK<Task for s1>',
    ]);

    const second = fakes();
    await triage(makeConfig(), [makeSuite()], { samples: 3, deps: second.deps });
    expect(second.calls.model).toHaveLength(3);
  });

  it('grades each sample `gradings` times with the grader prompt that asks for reasons', async () => {
    await oneFailure();
    const { deps, calls, contexts } = fakes();

    const config = makeConfig({ gradings: 3, graderPrompt: 'Custom rules.' });
    await triage(config, [makeSuite()], { deps });

    const expected = (n: number): string =>
      buildGraderPrompt(['c1', 'c2'], `code sample ${n}`, 'Custom rules.');
    expect(calls.grader.sort()).toEqual([1, 1, 1, 2, 2, 2].map(expected));
    expect(calls.grader[0]).toContain('one short reason citing the part of the answer');
    expect(contexts.every((ctx) => ctx.timeoutMs === 120_000 && ctx.cwd === root)).toBe(true);
  });

  it('records a failed generation and still triages with the samples that came back', async () => {
    await oneFailure();
    let n = 0;
    const { deps, calls } = fakes({
      model: async () => {
        if (++n === 1) throw new AdapterError('m1 timed out after 120s', 'timeout');
        return 'code that came back';
      },
    });

    const result = await triage(makeConfig(), [makeSuite()], { deps });

    expect(result.items[0]?.proposed).toBe('grader error');
    expect(calls.triager[0]).toContain('code that came back');
    const report = await readFile(result.reportPath, 'utf8');
    expect(report).toContain('m1 timed out after 120s');
  });

  it('does not ask for a classification when no sample could be generated', async () => {
    await oneFailure();
    const { deps, calls } = fakes({
      model: async () => {
        throw new AdapterError('m1 exited with code 1', 'exit');
      },
    });

    const result = await triage(makeConfig(), [makeSuite()], { deps });

    expect(calls.triager).toEqual([]);
    expect(result.items[0]?.proposed).toBe('unclassified');
    expect(result.items[0]?.reason).toMatch(/no sample/i);
  });

  it.each([
    ['generation', { model: async () => Promise.reject(new ConfigError('bad model')) }],
    ['grading', { grader: async () => Promise.reject(new ConfigError('bad grader')) }],
    ['classification', { triager: async () => Promise.reject(new ConfigError('bad triager')) }],
  ] as const)('lets a ConfigError from %s stop triage', async (_, over) => {
    await oneFailure();
    const { deps } = fakes(over);
    await expect(
      triage(makeConfig(), [makeSuite()], { deps }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it.each(['model', 'grader', 'triager'] as const)(
    'lets a %s CLI that cannot start stop triage',
    async (role) => {
      await oneFailure();
      const error = new AdapterError(`command (${role}) could not start: ENOENT`, 'spawn');
      const { deps } = fakes({ [role]: async () => Promise.reject(error) });

      await expect(triage(makeConfig(), [makeSuite()], { deps })).rejects.toBe(error);
    },
  );

  it('keeps at most `concurrency` model calls in flight', async () => {
    await writeSummary({
      skills: [
        skillSummary('demo', [summaryScenario(scenario('s1'), { m1: [[0, 0], [0, 0]] })], [
          { kind: 'zero', scenario: 's1', criterion: 0 },
          { kind: 'zero', scenario: 's1', criterion: 1 },
        ]),
      ],
    });
    let active = 0;
    let peak = 0;
    const slow =
      (reply: (prompt: string) => string): Adapter =>
      async (prompt) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return reply(prompt);
      };
    const { deps } = fakes({
      model: slow(() => 'code'),
      grader: slow(() => graderReply([false, false])),
      triager: slow(() => CLASSIFIED),
    });

    await triage(makeConfig({ concurrency: 2, gradings: 3 }), [makeSuite()], { samples: 3, deps });

    expect(peak).toBe(2);
  });
});

describe('triage classification', () => {
  it('asks `triage.model` to classify, with the definitions, the code and the grader reasons', async () => {
    await oneFailure();
    const { deps, calls } = fakes({
      grader: async (prompt) =>
        graderReply([true, false], `1. Uses pipe.\n2. Answer ${answerIn(prompt)} misses flatMap.`),
    });

    const result = await triage(makeConfig(), [makeSuite()], { deps });

    expect(calls.triager).toHaveLength(1);
    const prompt = calls.triager[0] as string;
    for (const definition of [
      "skill gap: the skill doesn't teach it clearly enough",
      'eval too strict: the answer is correct and idiomatic, but the criterion demands one form or ' +
        "something the prompt didn't ask for",
      'grader error: the answer satisfies the criterion and the grader still says NO',
      'model choice: the skill is clear and the model picks another reasonable approach',
    ]) {
      expect(prompt).toContain(definition);
    }
    expect(prompt).toContain('the demo skill');
    expect(prompt).toContain('Task for s1');
    expect(prompt).toContain('c2');
    expect(prompt).toContain('code sample 1');
    expect(prompt).toContain('code sample 2');
    expect(prompt).toContain('Answer code sample 1 misses flatMap.');
    expect(prompt).not.toContain('VERDICTS:');
    expect(result.items).toEqual([
      {
        skill: 'demo',
        scenario: 's1',
        criterion: 'c2',
        model: 'm1',
        proposed: 'grader error',
        reason: 'the code calls map.',
      },
    ]);
  });

  it('asks the failing model under test when `triage.model` is not set', async () => {
    await oneFailure();
    const { deps, contexts } = fakes();

    await triage(makeConfig({ triage: { model: null } }), [makeSuite()], { deps });

    // Two generations, two gradings, one classification.
    expect(contexts.map((ctx) => ctx.settings)).toEqual([MODEL, MODEL, GRADER, GRADER, MODEL]);
  });

  it('records an unparseable classification as unclassified with the raw answer', async () => {
    await oneFailure();
    const raw = 'I think the skill is fine but I cannot decide.';
    const { deps } = fakes({ triager: async () => raw });

    const result = await triage(makeConfig(), [makeSuite()], { deps });

    expect(result.items).toEqual([
      {
        skill: 'demo',
        scenario: 's1',
        criterion: 'c2',
        model: 'm1',
        proposed: 'unclassified',
        reason: 'the classification could not be parsed',
        rawAnswer: raw,
      },
    ]);
    expect(await readFile(result.reportPath, 'utf8')).toContain(raw);
  });

  it('records a failed classification call as unclassified', async () => {
    await oneFailure();
    const { deps } = fakes({
      triager: async () => {
        throw new AdapterError('triager timed out after 120s', 'timeout');
      },
    });

    const result = await triage(makeConfig(), [makeSuite()], { deps });

    expect(result.items[0]?.proposed).toBe('unclassified');
    expect(result.items[0]?.reason).toContain('triager timed out after 120s');
  });
});

describe('parseClassification', () => {
  it('reads the two final lines', () => {
    expect(parseClassification('CLASSIFICATION: skill gap\nREASON: never shows flatMap.')).toEqual({
      proposed: 'skill gap',
      reason: 'never shows flatMap.',
    });
  });

  it.each([
    [
      '**CLASSIFICATION:** **Eval too strict**\n**REASON:** demands `pipe`.',
      'eval too strict',
      'demands `pipe`.',
    ],
    ['## Classification: *model-choice*\n- Reason: picked a loop', 'model choice', 'picked a loop'],
    [
      '> CLASSIFICATION: "Grader Error".\n> REASON: it does call map',
      'grader error',
      'it does call map',
    ],
    ['```\nCLASSIFICATION: skill gap\nREASON: no example\n```', 'skill gap', 'no example'],
    [
      'CLASSIFICATION: grader error — the code calls map\nREASON: the code calls map',
      'grader error',
      'the code calls map',
    ],
  ])('tolerates markdown around the answer: %j', (answer, proposed, reason) => {
    expect(parseClassification(answer)).toEqual({ proposed, reason });
  });

  it('uses the last classification, after the reasoning mentions others', () => {
    const answer = [
      'CLASSIFICATION: skill gap would apply if the skill had no example.',
      'It does, so:',
      'CLASSIFICATION: model choice',
      'REASON: a loop is fine',
    ].join('\n');
    expect(parseClassification(answer)).toEqual({
      proposed: 'model choice',
      reason: 'a loop is fine',
    });
  });

  it.each([
    ['no lines at all', 'It is a grader error.'],
    ['an unknown category', 'CLASSIFICATION: flaky test\nREASON: noise'],
    ['no reason', 'CLASSIFICATION: skill gap'],
    ['an empty reason', 'CLASSIFICATION: skill gap\nREASON: **'],
    ['a reason before the classification', 'REASON: noise\nCLASSIFICATION: skill gap'],
  ])('returns null for %s', (_, answer) => {
    expect(parseClassification(answer)).toBeNull();
  });
});

describe('triage report', () => {
  it('writes the code, the grader reasons and the proposal beside the run', async () => {
    const runDir = await oneFailure();
    const { deps } = fakes({
      model: async () => 'const x = ```fenced``` thing;\n```ts\ninner();\n```',
      grader: async () => graderReply([true, false], '2. The answer never calls flatMap.'),
    });

    const result = await triage(makeConfig({ gradings: 2 }), [makeSuite()], { deps });

    expect(result.reportPath).toBe(path.join(runDir, 'triage-2026-10-31T10-00-00-000Z.md'));
    expect(await readdir(runDir)).toEqual(['summary.json', 'triage-2026-10-31T10-00-00-000Z.md']);
    const report = await readFile(result.reportPath, 'utf8');
    expect(report).toContain('# Triage');
    expect(report).toContain('demo');
    expect(report).toContain('s1');
    expect(report).toContain('c2');
    expect(report).toContain('universal 0%');
    expect(report).toContain('grader error');
    expect(report).toContain('the code calls map.');
    expect(report).toContain('The answer never calls flatMap.');
    expect(report).not.toContain('VERDICTS:');
    // The sample keeps its own fences inside a longer one.
    expect(report).toContain('````\nconst x = ```fenced``` thing;\n```ts\ninner();\n```\n````');
    expect(report).toMatch(/never blocks/i);
  });
});
