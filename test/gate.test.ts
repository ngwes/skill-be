import { describe, expect, it } from 'vitest';
import { evaluateGate, fmtDelta } from '../src/gate.js';
import type { CriterionScore, ModelResult, ScenarioResult, SkillRun } from '../src/runner.js';
import type { Config, Scenario } from '../src/types.js';

const ALL_ON: Config['gate'] = {
  regressionOnCritical: true,
  blockOnZero: true,
  blockOnErrors: true,
};

/** `[baselinePct, withSkillPct]` per criterion, for one model. */
type Scores = [number, number][];

const model = (label: string, scores: Scores, errors = 0): ModelResult => ({
  model: label,
  criteria: scores.map(
    ([baselinePct, withSkillPct]): CriterionScore => ({ baselinePct, withSkillPct }),
  ),
  notes: [],
  errors,
});

const scenarioResult = (
  id: string,
  criteria: string[],
  models: ModelResult[],
  critical = false,
): ScenarioResult => {
  const scenario: Scenario = { id, critical, prompt: `Task for ${id}`, criteria };
  return { scenario, models };
};

const run = (scenarios: ScenarioResult[], errorCount = 0): SkillRun => ({
  skill: 'demo',
  scenarios,
  errorCount,
  startedAt: '2026-10-31T09:00:00.000Z',
  durationMs: 1000,
});

describe('fmtDelta', () => {
  it('signs every delta, with +0pp for no change', () => {
    expect(fmtDelta(-67)).toBe('-67pp');
    expect(fmtDelta(0)).toBe('+0pp');
    expect(fmtDelta(25)).toBe('+25pp');
  });
});

describe('evaluateGate', () => {
  it('is READY when nothing blocks', () => {
    const result = evaluateGate(
      run([
        scenarioResult('s1', ['c1', 'c2'], [model('m1', [[0, 100], [50, 50]])], true),
        scenarioResult('s2', ['c1'], [model('m1', [[100, 100]])]),
      ]),
      ALL_ON,
    );
    expect(result).toEqual({ ready: true, reasons: [], blocks: [] });
  });

  describe('universal 0%', () => {
    it('blocks a criterion at 0% with the skill on every model', () => {
      const result = evaluateGate(
        run([
          scenarioResult(
            'result-chain',
            ['uses map', 'uses chain'],
            [model('m1', [[0, 100], [50, 0]]), model('m2', [[0, 100], [0, 0]])],
          ),
        ]),
        ALL_ON,
      );
      expect(result.ready).toBe(false);
      expect(result.reasons).toEqual([
        '**BLOCKED** (universal 0%): `result-chain` — criterion: *"uses chain"*',
      ]);
      expect(result.blocks).toEqual([{ kind: 'zero', scenario: 'result-chain', criterion: 1 }]);
    });

    it('blocks a single model at 0%', () => {
      const result = evaluateGate(
        run([scenarioResult('s1', ['c1'], [model('m1', [[0, 0]])])]),
        ALL_ON,
      );
      expect(result.reasons).toEqual(['**BLOCKED** (universal 0%): `s1` — criterion: *"c1"*']);
    });

    it('does not block a criterion at 0% on only one of two models', () => {
      const result = evaluateGate(
        run([scenarioResult('s1', ['c1'], [model('m1', [[0, 0]]), model('m2', [[0, 33]])])]),
        ALL_ON,
      );
      expect(result).toEqual({ ready: true, reasons: [], blocks: [] });
    });

    it('blocks in a non-critical scenario too', () => {
      const result = evaluateGate(
        run([scenarioResult('s1', ['c1'], [model('m1', [[100, 0]])], false)]),
        ALL_ON,
      );
      expect(result.blocks).toEqual([{ kind: 'zero', scenario: 's1', criterion: 0 }]);
    });

    it('is switched off by blockOnZero: false', () => {
      const result = evaluateGate(
        run([scenarioResult('s1', ['c1'], [model('m1', [[0, 0]])])]),
        { ...ALL_ON, blockOnZero: false },
      );
      expect(result).toEqual({ ready: true, reasons: [], blocks: [] });
    });
  });

  describe('critical regression', () => {
    it('blocks a critical scenario that scores lower with the skill on a model', () => {
      const result = evaluateGate(
        run([
          scenarioResult(
            'crit',
            ['c1', 'writes a pipe'],
            [model('m1', [[0, 100], [100, 33]]), model('m2', [[0, 100], [100, 100]])],
            true,
          ),
        ]),
        ALL_ON,
      );
      expect(result.ready).toBe(false);
      expect(result.reasons).toEqual([
        '**BLOCKED** (regression): `crit` / m1 — *"writes a pipe"*: 100% → 33% (-67pp)',
      ]);
      expect(result.blocks).toEqual([
        { kind: 'regression', scenario: 'crit', criterion: 1, model: 'm1' },
      ]);
    });

    it('uses the model label as it is', () => {
      const result = evaluateGate(
        run([
          scenarioResult(
            'crit',
            ['c1'],
            [model('claude-cli:sonnet#2', [[100, 50]]), model('other', [[0, 100]])],
            true,
          ),
        ]),
        ALL_ON,
      );
      expect(result.reasons).toEqual([
        '**BLOCKED** (regression): `crit` / claude-cli:sonnet#2 — *"c1"*: 100% → 50% (-50pp)',
      ]);
      expect(result.blocks).toEqual([
        { kind: 'regression', scenario: 'crit', criterion: 0, model: 'claude-cli:sonnet#2' },
      ]);
    });

    it('does not block the same drop in a non-critical scenario', () => {
      const result = evaluateGate(
        run([scenarioResult('s1', ['c1'], [model('m1', [[100, 33]])], false)]),
        ALL_ON,
      );
      expect(result).toEqual({ ready: true, reasons: [], blocks: [] });
    });

    it('does not block a critical criterion that stays level or improves', () => {
      const result = evaluateGate(
        run([scenarioResult('s1', ['c1', 'c2'], [model('m1', [[67, 67], [33, 100]])], true)]),
        ALL_ON,
      );
      expect(result).toEqual({ ready: true, reasons: [], blocks: [] });
    });

    it('lists every model that regressed, in model order', () => {
      const result = evaluateGate(
        run([
          scenarioResult(
            'crit',
            ['c1'],
            [model('m1', [[100, 67]]), model('m2', [[100, 100]]), model('m3', [[67, 0]])],
            true,
          ),
        ]),
        ALL_ON,
      );
      expect(result.blocks).toEqual([
        { kind: 'regression', scenario: 'crit', criterion: 0, model: 'm1' },
        { kind: 'regression', scenario: 'crit', criterion: 0, model: 'm3' },
      ]);
    });

    it('is switched off by regressionOnCritical: false', () => {
      const result = evaluateGate(
        run([scenarioResult('crit', ['c1'], [model('m1', [[100, 33]])], true)]),
        { ...ALL_ON, regressionOnCritical: false },
      );
      expect(result).toEqual({ ready: true, reasons: [], blocks: [] });
    });
  });

  describe('errors', () => {
    it('blocks when an output could not be generated or graded', () => {
      const result = evaluateGate(
        run([scenarioResult('s1', ['c1'], [model('m1', [[0, 100]], 3)])], 3),
        ALL_ON,
      );
      expect(result.ready).toBe(false);
      expect(result.reasons).toEqual([
        '**[ERROR]** 3 output(s) could not be generated or graded; their criteria were counted as 0 (see the scenario notes).',
      ]);
      expect(result.blocks).toEqual([{ kind: 'error' }]);
    });

    it('is switched off by blockOnErrors: false', () => {
      const result = evaluateGate(
        run([scenarioResult('s1', ['c1'], [model('m1', [[0, 100]], 3)])], 3),
        { ...ALL_ON, blockOnErrors: false },
      );
      expect(result).toEqual({ ready: true, reasons: [], blocks: [] });
    });
  });

  it('lists the error first, then each scenario and criterion with zero before regressions', () => {
    const result = evaluateGate(
      run(
        [
          // c1 is a regression on m1 only; c2 is at 0% on both models and regresses on m1.
          scenarioResult(
            'first',
            ['c1', 'c2'],
            [model('m1', [[100, 50], [100, 0]]), model('m2', [[0, 100], [0, 0]])],
            true,
          ),
          scenarioResult('second', ['c1'], [model('m1', [[0, 0]]), model('m2', [[0, 0]])]),
        ],
        2,
      ),
      ALL_ON,
    );
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual([
      '**[ERROR]** 2 output(s) could not be generated or graded; their criteria were counted as 0 (see the scenario notes).',
      '**BLOCKED** (regression): `first` / m1 — *"c1"*: 100% → 50% (-50pp)',
      '**BLOCKED** (universal 0%): `first` — criterion: *"c2"*',
      '**BLOCKED** (regression): `first` / m1 — *"c2"*: 100% → 0% (-100pp)',
      '**BLOCKED** (universal 0%): `second` — criterion: *"c1"*',
    ]);
    expect(result.blocks).toEqual([
      { kind: 'error' },
      { kind: 'regression', scenario: 'first', criterion: 0, model: 'm1' },
      { kind: 'zero', scenario: 'first', criterion: 1 },
      { kind: 'regression', scenario: 'first', criterion: 1, model: 'm1' },
      { kind: 'zero', scenario: 'second', criterion: 0 },
    ]);
  });

  it('keeps the other rules when one is switched off', () => {
    const result = evaluateGate(
      run([scenarioResult('crit', ['c1'], [model('m1', [[100, 0]])], true)], 1),
      { regressionOnCritical: true, blockOnZero: false, blockOnErrors: false },
    );
    expect(result.blocks).toEqual([
      { kind: 'regression', scenario: 'crit', criterion: 0, model: 'm1' },
    ]);
  });

  it('is READY with all three rules off, whatever the run holds', () => {
    const result = evaluateGate(
      run([scenarioResult('crit', ['c1'], [model('m1', [[100, 0]], 2)], true)], 2),
      { regressionOnCritical: false, blockOnZero: false, blockOnErrors: false },
    );
    expect(result).toEqual({ ready: true, reasons: [], blocks: [] });
  });
});
