/**
 * The release gate: the per-skill verdict, READY or NOT READY.
 *
 * This is a port of the "Release Gate" section of mini-fp-skills `scripts/run-benchmark.mjs`.
 * The reason strings are byte-identical to its output, because the repos that grep reports for
 * `**BLOCKED**` and `[ERROR]` keep working.
 */

import { Option } from '@ngwes/mini-fp';
import type { SkillRun } from './runner.js';
import type { Config } from './types.js';

/**
 * The structured form of one reason: what blocked, and where. `criterion` is the 0-based index
 * into the scenario's `criteria`; `model` is the model's label.
 */
export type GateBlock = {
  kind: 'zero' | 'regression' | 'error';
  scenario?: string;
  criterion?: number;
  model?: string;
};

export type GateVerdict = {
  ready: boolean;
  /** The report lines, one per block. */
  reasons: string[];
  /** One entry per reason, in the same order. */
  blocks: GateBlock[];
};

/** A percentage-point change with its sign: `-67pp`, `+0pp`, `+25pp`. */
export function fmtDelta(delta: number): string {
  return delta >= 0 ? `+${delta}pp` : `${delta}pp`;
}

/**
 * Decides whether a skill is READY. It is NOT READY when any enabled rule holds:
 * - `blockOnErrors`: an output could not be generated or graded (`run.errorCount > 0`).
 * - `blockOnZero`: a criterion scores 0% with the skill on every model under test.
 * - `regressionOnCritical`: in a critical scenario, a criterion scores lower with the skill than
 *   in the baseline on a model.
 *
 * The error comes first, then each scenario's criteria in order, a criterion's zero block before
 * its regressions, which go in model order.
 */
export function evaluateGate(run: SkillRun, gate: Config['gate']): GateVerdict {
  const reasons: string[] = [];
  const blocks: GateBlock[] = [];
  const block = (reason: string, entry: GateBlock): void => {
    reasons.push(reason);
    blocks.push(entry);
  };

  if (gate.blockOnErrors && run.errorCount > 0) {
    block(
      `**[ERROR]** ${run.errorCount} output(s) could not be generated or graded; their criteria were counted as 0 (see the scenario notes).`,
      { kind: 'error' },
    );
  }

  for (const { scenario, models } of run.scenarios) {
    scenario.criteria.forEach((criterion, c) => {
      const zeroEverywhere = models.every(
        (model) =>
          Option.from(model.criteria[c])
            .map((score) => score.withSkillPct)
            .orElse(0) === 0,
      );
      if (gate.blockOnZero && zeroEverywhere) {
        block(`**BLOCKED** (universal 0%): \`${scenario.id}\` — criterion: *"${criterion}"*`, {
          kind: 'zero',
          scenario: scenario.id,
          criterion: c,
        });
      }

      if (gate.regressionOnCritical && scenario.critical) {
        for (const model of models) {
          Option.from(model.criteria[c])
            .filter((score) => score.withSkillPct < score.baselinePct)
            .onSome((score) =>
              block(
                `**BLOCKED** (regression): \`${scenario.id}\` / ${model.model} — *"${criterion}"*: ${score.baselinePct}% → ${score.withSkillPct}% (${fmtDelta(score.withSkillPct - score.baselinePct)})`,
                { kind: 'regression', scenario: scenario.id, criterion: c, model: model.model },
              ),
            );
        }
      }
    });
  }

  return { ready: reasons.length === 0, reasons, blocks };
}
