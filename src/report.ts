/**
 * The markdown report of one skill and the JSON summary of a run.
 *
 * The report continues the run log that mini-fp-skills keeps in
 * `docs/skill-benchmark-runs-log.md`: the structure of the output of its `run-benchmark.mjs`, so
 * the strings people grep for (`[ERROR]`, `[NOTE]`, `## Release Gate`, `**NOT READY**`) stay put.
 * The summary is what triage reads.
 */

import { Option } from '@ngwes/mini-fp';
import { fmtDelta, type GateBlock, type GateVerdict } from './gate.js';
import type { CriterionScore, SkillRun } from './runner.js';
import type { AdapterSettings } from './types.js';

/** How the benchmark was run, as the `Method:` line names it. */
export type ReportMethod = {
  /** The models under test, in config order. */
  models: AdapterSettings[];
  grader: AdapterSettings;
  reps: number;
  gradings: number;
  /** The date of the run, `YYYY-MM-DD`. */
  date: string;
};

const NOTE_LINE =
  'Note: "with skill" puts the SKILL.md content in the user prompt.';

const READY_LINE = '**READY** — No universal 0% criteria. No critical regressions.';

/** A table cell: a `|` would end it and a line break would end the row. */
export function cell(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\|/g, '\\|');
}

/**
 * The markdown section of one skill: the method, one table per scenario and model, and the
 * Release Gate. It ends the way the console output of `run-benchmark.mjs` does, with a blank
 * line, so reports can be appended to the log back to back.
 */
export function renderReport(
  run: SkillRun,
  gate: Pick<GateVerdict, 'ready' | 'reasons'>,
  method: ReportMethod,
): string {
  const out: string[] = [];

  out.push(`## ${method.date} — ${run.skill} benchmark`);
  out.push('');
  out.push(
    `Method: automated eval. ` +
      `Models: ${method.models.map((model) => `${model.adapter}:${model.id}`).join(', ')}. ` +
      `Reps: ${method.reps}. ` +
      `Grading: majority of ${method.gradings} ${method.grader.id} calls per output ` +
      `(via ${method.grader.adapter}).`,
  );
  out.push(NOTE_LINE);
  out.push('');

  for (const { scenario, models } of run.scenarios) {
    out.push(`### Scenario: ${scenario.id}${scenario.critical ? ' *(critical)*' : ''}`);
    out.push('');
    out.push(`*${scenario.prompt}*`);
    out.push('');

    for (const model of models) {
      out.push(`**${model.model}**`);
      out.push('');
      out.push('| Criterion | Baseline | With skill | Delta |');
      out.push('|-----------|----------|------------|-------|');
      scenario.criteria.forEach((criterion, c) => {
        const { baselinePct, withSkillPct } = Option.from<CriterionScore>(
          model.criteria[c],
        ).orElse({ baselinePct: 0, withSkillPct: 0 });
        out.push(
          `| ${cell(criterion)} | ${baselinePct}% | ${withSkillPct}% | ` +
            `${fmtDelta(withSkillPct - baselinePct)} |`,
        );
      });

      if (model.notes.length > 0) {
        out.push('');
        // Notes carry their own `[ERROR]` or `[NOTE]` level, the errors first.
        for (const note of model.notes) out.push(`- ${note}`);
      }
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push('## Release Gate');
  out.push('');
  if (gate.ready) {
    out.push(READY_LINE);
  } else {
    for (const reason of gate.reasons) out.push(`- ${reason}`);
    out.push('');
    out.push('**NOT READY**');
  }
  out.push('');

  return `${out.join('\n')}\n`;
}

export type ModelSummary = {
  /** The model's label, as in the report. */
  model: string;
  /** One score per criterion, in criterion order. */
  criteria: CriterionScore[];
  /** `[ERROR] ...` notes first, then `[NOTE] ...` notes. */
  notes: string[];
};

export type ScenarioSummary = {
  id: string;
  critical: boolean;
  prompt: string;
  criteria: string[];
  /** In config order. */
  models: ModelSummary[];
};

export type SkillSummary = {
  skill: string;
  /** ISO time the run started. */
  startedAt: string;
  durationMs: number;
  errorCount: number;
  /** The gate's verdict, with the reasons and, for each, what it blocked on and where. */
  ready: boolean;
  reasons: string[];
  blocks: GateBlock[];
  scenarios: ScenarioSummary[];
};

/** What `summary.json` holds: a plain JSON-serializable object, one entry per skill run. */
export type RunSummary = { skills: SkillSummary[] };

/**
 * The summary of a run, from the skills' runs and their gate verdicts (keyed by skill name).
 * It copies what it keeps, so it does not share arrays with the runs.
 *
 * @throws when a skill has no verdict in `gates`.
 */
export function toSummary(
  runs: readonly SkillRun[],
  gates: ReadonlyMap<string, GateVerdict>,
): RunSummary {
  return {
    skills: runs.map((run) => {
      const gate = Option.from(gates.get(run.skill)).orElse(() => {
        throw new Error(`No gate verdict for skill "${run.skill}"`);
      });
      return {
        skill: run.skill,
        startedAt: run.startedAt,
        durationMs: run.durationMs,
        errorCount: run.errorCount,
        ready: gate.ready,
        reasons: [...gate.reasons],
        blocks: gate.blocks.map((block) => ({ ...block })),
        scenarios: run.scenarios.map(({ scenario, models }) => ({
          id: scenario.id,
          critical: scenario.critical,
          prompt: scenario.prompt,
          criteria: [...scenario.criteria],
          models: models.map((model) => ({
            model: model.model,
            criteria: model.criteria.map(({ baselinePct, withSkillPct }) => ({
              baselinePct,
              withSkillPct,
            })),
            notes: [...model.notes],
          })),
        })),
      };
    }),
  };
}
