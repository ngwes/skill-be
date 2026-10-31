import { describe, expect, it } from 'vitest';
import { evaluateGate, type GateVerdict } from '../src/gate.js';
import { renderReport, toSummary, type RunSummary } from '../src/report.js';
import type { CriterionScore, ModelResult, ScenarioResult, SkillRun } from '../src/runner.js';
import type { AdapterSettings, Config, Scenario } from '../src/types.js';

const ALL_ON: Config['gate'] = {
  regressionOnCritical: true,
  blockOnZero: true,
  blockOnErrors: true,
};

const SONNET: AdapterSettings = { adapter: 'claude-cli', id: 'claude-sonnet-5-5' };
const GPT: AdapterSettings = { adapter: 'pi-cli', id: 'gpt-x', provider: 'acme' };
const HAIKU: AdapterSettings = { adapter: 'claude-cli', id: 'claude-haiku-5-5' };

const METHOD = {
  models: [SONNET, GPT],
  grader: HAIKU,
  reps: 3,
  gradings: 3,
  date: '2026-10-31',
};

const READY_GATE = { ready: true, reasons: [] };

const model = (
  label: string,
  scores: [number, number][],
  notes: string[] = [],
  errors = 0,
): ModelResult => ({
  model: label,
  criteria: scores.map(
    ([baselinePct, withSkillPct]): CriterionScore => ({ baselinePct, withSkillPct }),
  ),
  notes,
  errors,
});

const scenarioResult = (
  scenario: Partial<Scenario> & { id: string; criteria: string[] },
  models: ModelResult[],
): ScenarioResult => ({
  scenario: { critical: false, prompt: `Task for ${scenario.id}`, ...scenario },
  models,
});

const run = (scenarios: ScenarioResult[], errorCount = 0): SkillRun => ({
  skill: 'validate',
  scenarios,
  errorCount,
  startedAt: '2026-10-31T09:00:00.000Z',
  durationMs: 4200,
});

/** Two scenarios, a critical one with a regression and a plain one with notes. */
const fixture = (): SkillRun =>
  run(
    [
      scenarioResult(
        {
          id: 'accumulate-field-errors',
          critical: true,
          prompt: 'Write validators for a signup form. Return ALL errors at once.',
          criteria: ['Uses Validate (not Either)', 'Returns all errors, not just the first'],
        },
        [
          model('claude-sonnet-5-5', [
            [0, 100],
            [100, 100],
          ]),
          model('gpt-x', [
            [0, 67],
            [100, 67],
          ]),
        ],
      ),
      scenarioResult(
        {
          id: 'batch-array-validation',
          prompt: 'Validate an array of numbers.',
          criteria: ['Uses sequenceValidate'],
        },
        [
          model('claude-sonnet-5-5', [[100, 100]]),
          model(
            'gpt-x',
            [[33, 0]],
            [
              '[ERROR] rep 1 baseline — generation failed, criteria counted as 0: timed out',
              '[NOTE] rep 2 with skill — 1 of 3 gradings failed and was dropped',
            ],
            1,
          ),
        ],
      ),
    ],
    1,
  );

describe('renderReport', () => {
  it('renders the structure of a mini-fp-skills log section', () => {
    const verdict = evaluateGate(fixture(), ALL_ON);
    const report = renderReport(fixture(), verdict, METHOD);

    expect(report).toBe(
      [
        '## 2026-10-31 — validate benchmark',
        '',
        'Method: automated eval. Models: claude-cli:claude-sonnet-5-5, pi-cli:gpt-x. Reps: 3. ' +
          'Grading: majority of 3 claude-haiku-5-5 calls per output (via claude-cli).',
        'Note: "with skill" puts the SKILL.md content in the user prompt.',
        '',
        '### Scenario: accumulate-field-errors *(critical)*',
        '',
        '*Write validators for a signup form. Return ALL errors at once.*',
        '',
        '**claude-sonnet-5-5**',
        '',
        '| Criterion | Baseline | With skill | Delta |',
        '|-----------|----------|------------|-------|',
        '| Uses Validate (not Either) | 0% | 100% | +100pp |',
        '| Returns all errors, not just the first | 100% | 100% | +0pp |',
        '',
        '**gpt-x**',
        '',
        '| Criterion | Baseline | With skill | Delta |',
        '|-----------|----------|------------|-------|',
        '| Uses Validate (not Either) | 0% | 67% | +67pp |',
        '| Returns all errors, not just the first | 100% | 67% | -33pp |',
        '',
        '### Scenario: batch-array-validation',
        '',
        '*Validate an array of numbers.*',
        '',
        '**claude-sonnet-5-5**',
        '',
        '| Criterion | Baseline | With skill | Delta |',
        '|-----------|----------|------------|-------|',
        '| Uses sequenceValidate | 100% | 100% | +0pp |',
        '',
        '**gpt-x**',
        '',
        '| Criterion | Baseline | With skill | Delta |',
        '|-----------|----------|------------|-------|',
        '| Uses sequenceValidate | 33% | 0% | -33pp |',
        '',
        '- [ERROR] rep 1 baseline — generation failed, criteria counted as 0: timed out',
        '- [NOTE] rep 2 with skill — 1 of 3 gradings failed and was dropped',
        '',
        '---',
        '',
        '## Release Gate',
        '',
        '- **[ERROR]** 1 output(s) could not be generated or graded; their criteria were counted ' +
          'as 0 (see the scenario notes).',
        '- **BLOCKED** (regression): `accumulate-field-errors` / gpt-x — *"Returns all errors, ' +
          'not just the first"*: 100% → 67% (-33pp)',
        '',
        '**NOT READY**',
        '',
        '',
      ].join('\n'),
    );
  });

  it('ends like the console output of run-benchmark.mjs, so sections can be appended', () => {
    const report = renderReport(fixture(), READY_GATE, METHOD);
    const ready = '**READY** — No universal 0% criteria. No critical regressions.';
    expect(report.endsWith(`${ready}\n\n`)).toBe(true);
  });

  it('renders the READY line, with no list and no NOT READY', () => {
    const report = renderReport(fixture(), READY_GATE, METHOD);
    expect(report).toContain(
      '---\n\n## Release Gate\n\n' +
        '**READY** — No universal 0% criteria. No critical regressions.\n',
    );
    expect(report).not.toContain('NOT READY');
  });

  it('renders every reason as a list item above NOT READY', () => {
    const report = renderReport(
      fixture(),
      {
        ready: false,
        reasons: ['**BLOCKED** (universal 0%): `a` — x', '**BLOCKED** (regression): y'],
      },
      METHOD,
    );
    expect(report).toContain(
      '## Release Gate\n\n' +
        '- **BLOCKED** (universal 0%): `a` — x\n' +
        '- **BLOCKED** (regression): y\n\n' +
        '**NOT READY**\n',
    );
    expect(report).not.toContain('**READY**');
  });

  it('marks only critical scenarios', () => {
    const report = renderReport(fixture(), READY_GATE, METHOD);
    expect(report).toContain('### Scenario: accumulate-field-errors *(critical)*\n');
    expect(report).toContain('### Scenario: batch-array-validation\n');
  });

  it('lists notes under their own model table and nothing under one without notes', () => {
    const report = renderReport(fixture(), READY_GATE, METHOD);
    const lines = report.split('\n');
    const notes = lines.filter((line) => line.startsWith('- [')).length;
    expect(notes).toBe(2);
    // A model without notes is followed by the next heading, with one blank line between.
    const sonnet = lines.indexOf('| Uses sequenceValidate | 100% | 100% | +0pp |');
    expect(lines.slice(sonnet + 1, sonnet + 3)).toEqual(['', '**gpt-x**']);
  });

  it('names the adapter and id of each model under test, and the grader id', () => {
    const report = renderReport(fixture(), READY_GATE, {
      ...METHOD,
      models: [SONNET],
      reps: 5,
      gradings: 1,
      date: '2027-01-02',
    });
    expect(report).toContain('## 2027-01-02 — validate benchmark\n');
    expect(report).toContain(
      'Method: automated eval. Models: claude-cli:claude-sonnet-5-5. Reps: 5. ' +
        'Grading: majority of 1 claude-haiku-5-5 calls per output (via claude-cli).\n',
    );
  });

  it('keeps a pipe or a line break in a criterion inside its table cell', () => {
    const report = renderReport(
      run([
        scenarioResult(
          {
            id: 's',
            criteria: ['Types the input as string | number', 'Handles\nnull and undefined'],
          },
          [
            model('m', [
              [0, 100],
              [0, 100],
            ]),
          ],
        ),
      ]),
      READY_GATE,
      METHOD,
    );
    expect(report).toContain('| Types the input as string \\| number | 0% | 100% | +100pp |\n');
    expect(report).toContain('| Handles null and undefined | 0% | 100% | +100pp |\n');
  });

  it('puts the gate reasons of a real verdict in the report byte for byte', () => {
    const verdict = evaluateGate(fixture(), ALL_ON);
    const report = renderReport(fixture(), verdict, METHOD);
    for (const reason of verdict.reasons) expect(report).toContain(`\n- ${reason}\n`);
    expect(report).toContain('\n\n**NOT READY**\n');
  });
});

describe('toSummary', () => {
  const gateFor = (skillRun: SkillRun): GateVerdict => evaluateGate(skillRun, ALL_ON);

  it('summarizes each skill with its run, its gate and its scenarios', () => {
    const skillRun = fixture();
    const gate = gateFor(skillRun);
    const summary: RunSummary = toSummary([skillRun], new Map([['validate', gate]]));

    expect(summary).toEqual({
      skills: [
        {
          skill: 'validate',
          startedAt: '2026-10-31T09:00:00.000Z',
          durationMs: 4200,
          errorCount: 1,
          ready: false,
          reasons: gate.reasons,
          blocks: gate.blocks,
          scenarios: [
            {
              id: 'accumulate-field-errors',
              critical: true,
              prompt: 'Write validators for a signup form. Return ALL errors at once.',
              criteria: ['Uses Validate (not Either)', 'Returns all errors, not just the first'],
              models: [
                {
                  model: 'claude-sonnet-5-5',
                  criteria: [
                    { baselinePct: 0, withSkillPct: 100 },
                    { baselinePct: 100, withSkillPct: 100 },
                  ],
                  notes: [],
                },
                {
                  model: 'gpt-x',
                  criteria: [
                    { baselinePct: 0, withSkillPct: 67 },
                    { baselinePct: 100, withSkillPct: 67 },
                  ],
                  notes: [],
                },
              ],
            },
            {
              id: 'batch-array-validation',
              critical: false,
              prompt: 'Validate an array of numbers.',
              criteria: ['Uses sequenceValidate'],
              models: [
                {
                  model: 'claude-sonnet-5-5',
                  criteria: [{ baselinePct: 100, withSkillPct: 100 }],
                  notes: [],
                },
                {
                  model: 'gpt-x',
                  criteria: [{ baselinePct: 33, withSkillPct: 0 }],
                  notes: [
                    '[ERROR] rep 1 baseline — generation failed, criteria counted as 0: ' +
                      'timed out',
                    '[NOTE] rep 2 with skill — 1 of 3 gradings failed and was dropped',
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('survives a JSON round trip unchanged', () => {
    const skillRun = fixture();
    const summary = toSummary([skillRun], new Map([['validate', gateFor(skillRun)]]));
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('keeps the skills in run order, each with its own gate', () => {
    const ready: GateVerdict = { ready: true, reasons: [], blocks: [] };
    const other: SkillRun = { ...run([]), skill: 'option' };
    const summary = toSummary(
      [other, fixture()],
      new Map([
        ['validate', gateFor(fixture())],
        ['option', ready],
      ]),
    );
    expect(summary.skills.map((s) => [s.skill, s.ready])).toEqual([
      ['option', true],
      ['validate', false],
    ]);
    expect(summary.skills[0]?.scenarios).toEqual([]);
  });

  it('drops what triage does not read, such as the per-model error count', () => {
    const skillRun = fixture();
    const summary = toSummary([skillRun], new Map([['validate', gateFor(skillRun)]]));
    const first = summary.skills[0]?.scenarios[1]?.models[1];
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual(['criteria', 'model', 'notes']);
  });

  it('holds no reference to the run, so later changes to the run do not reach it', () => {
    const skillRun = fixture();
    const gate = gateFor(skillRun);
    const summary = toSummary([skillRun], new Map([['validate', gate]]));
    skillRun.scenarios[0]?.models[0]?.notes.push('[NOTE] added later');
    skillRun.scenarios[0]?.scenario.criteria.push('added later');
    gate.reasons.push('added later');
    gate.blocks.push({ kind: 'error' });
    expect(summary.skills[0]?.scenarios[0]?.models[0]?.notes).toEqual([]);
    expect(summary.skills[0]?.scenarios[0]?.criteria).toHaveLength(2);
    expect(summary.skills[0]?.reasons).toHaveLength(2);
    expect(summary.skills[0]?.blocks).toHaveLength(2);
  });

  it('throws when a skill has no gate verdict', () => {
    expect(() => toSummary([fixture()], new Map())).toThrow(/validate/);
  });
});
