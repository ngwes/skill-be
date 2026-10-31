/**
 * Triage: a closer look at the criteria that failed in the latest run. For each one it generates
 * fresh with-skill samples, grades them with the grader's reasons kept, and asks a model to
 * propose one of four classifications, for a human to confirm. It never blocks anything.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isConfigProblem, resolveAdapter, type Adapter } from './adapters/index.js';
import { gradeOutput, graderReasons, parseVerdicts } from './grader.js';
import { createLimiter } from './limiter.js';
import { cell, type RunSummary, type SkillSummary } from './report.js';
import { fillTemplate, modelLabels, resultsTimestamp, type CriterionScore } from './runner.js';
import {
  ConfigError,
  type AdapterSettings,
  type Config,
  type Scenario,
  type SkillSuite,
} from './types.js';

export const TRIAGE_CATEGORIES = [
  'skill gap',
  'eval too strict',
  'grader error',
  'model choice',
] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/** The definitions the triage model classifies by, from the design. */
const DEFINITIONS: Record<TriageCategory, string> = {
  'skill gap': "the skill doesn't teach it clearly enough",
  'eval too strict':
    'the answer is correct and idiomatic, but the criterion demands one form or something the ' +
    "prompt didn't ask for",
  'grader error': 'the answer satisfies the criterion and the grader still says NO',
  'model choice': 'the skill is clear and the model picks another reasonable approach',
};

export type TriageItem = {
  skill: string;
  scenario: string;
  /** The criterion's text. */
  criterion: string;
  /** The label of the model under test whose samples were triaged, as in the run. */
  model: string;
  /** `unclassified` when no sample came back, or the classification failed or was unparseable. */
  proposed: TriageCategory | 'unclassified';
  /** The triage model's one-line reason, or why the failure is unclassified. */
  reason: string;
  /** The triage model's reply, kept when it could not be parsed. */
  rawAnswer?: string;
};

export type TriageDeps = {
  /** Resolves an entry's adapter; `resolveAdapter` against the config root by default. */
  adapterFor?: (settings: AdapterSettings) => Promise<Adapter>;
  /** Receives one progress line at a time; stderr by default. */
  log?: (line: string) => void;
  /** Names the report, `triage-<timestamp>.md`; a new `resultsTimestamp()` by default. */
  timestamp?: string;
};

export type TriageOptions = {
  /** Also triage every criterion that scored under this percentage with the skill. */
  below?: number;
  /** Fresh with-skill samples per failing criterion; 2 by default. */
  samples?: number;
  deps?: TriageDeps;
};

/** One failure to triage: a criterion of a scenario, on one model under test. */
type Target = {
  suite: SkillSuite;
  scenario: Scenario;
  /** The criterion's index in the current eval file. */
  criterion: number;
  label: string;
  settings: AdapterSettings;
  /** Why it is triaged: the blocks it caused and whether it scored under `below`. */
  causes: string[];
  score: CriterionScore;
};

/** One graded grading of a sample: its verdict on the triaged criterion and its reasons. */
type Grading = { verdict: 0 | 1 | null; reasons: string };

type Sample =
  | { output: string; verdict: 0 | 1 | null; gradings: Grading[] }
  | { error: string };

type Triaged = { target: Target; samples: Sample[]; item: TriageItem };

/** A results subdirectory named by `resultsTimestamp()`, such as `2026-10-31T09-05-03-042Z`. */
const RUN_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/**
 * Triages the failing criteria of the given skills in the latest run: the newest results
 * directory with a `summary.json`. A criterion fails when it caused a `zero` block (triaged on
 * every model under test) or a `regression` block (on its model), and, with `below`, when it
 * scored under `below`% with the skill on a model. `error` blocks name no criterion: they are
 * listed in the report as not triaged, and so is a failure whose scenario, criterion or model
 * the current eval file or config no longer has.
 *
 * For each failure: `samples` with-skill generations by that model, each graded `gradings` times
 * with the grader prompt (which asks for a reason per criterion), then one classification by
 * `triage.model`, else by that failure's own model under test (the one whose output failed, not
 * the grader, since grader errors are one of the categories). Every call goes through one
 * limiter of `concurrency`. A failed call is recorded in the report; a config problem (a
 * `ConfigError`, or a CLI that cannot start: see `isConfigProblem`) rejects `triage`.
 *
 * Writes `<run dir>/triage-<timestamp>.md` with the code, the grader reasons and the proposals.
 *
 * @throws ConfigError when there is no run with a summary, or the summary cannot be read.
 */
export async function triage(
  config: Config,
  suites: SkillSuite[],
  opts: TriageOptions = {},
): Promise<{ reportPath: string; items: TriageItem[] }> {
  const deps = opts.deps ?? {};
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const adapterFor =
    deps.adapterFor ??
    ((settings: AdapterSettings) => resolveAdapter(settings.adapter, config.root));
  const sampleCount = opts.samples ?? 2;
  const classifierOf = (target: Target): AdapterSettings => config.triage.model ?? target.settings;

  const run = await latestRun(config.results);
  const { targets, notes } = selectTargets(run.summary, suites, config.models, opts.below);
  const reportPath = path.join(run.dir, `triage-${deps.timestamp ?? resultsTimestamp()}.md`);
  log(`triage: ${targets.length} failure(s) to triage in run ${run.name}`);

  // Resolve every adapter before the first call, so a config error stops triage at once.
  const adapters = new Map<AdapterSettings, Adapter>();
  if (targets.length > 0) {
    const needed = new Set([
      ...targets.flatMap((t) => [t.settings, classifierOf(t)]),
      config.grader,
    ]);
    for (const settings of needed) adapters.set(settings, await adapterFor(settings));
  }

  const limit = createLimiter(config.concurrency);
  const timeoutMs = config.timeoutSeconds * 1000;
  const call = (settings: AdapterSettings, prompt: string): Promise<string> =>
    limit(() =>
      (adapters.get(settings) as Adapter)(prompt, { settings, timeoutMs, cwd: config.root }),
    );
  const grade = (prompt: string): Promise<string> => call(config.grader, prompt);

  async function sample(target: Target, prompt: string): Promise<Sample> {
    let output: string;
    try {
      output = await call(target.settings, prompt);
    } catch (error) {
      if (isConfigProblem(error)) throw error;
      return { error: messageOf(error) };
    }
    const { criteria } = target.scenario;
    const graded = await gradeOutput(
      criteria,
      output,
      grade,
      config.gradings,
      config.graderPrompt ?? undefined,
    );
    return {
      output,
      verdict: graded.verdicts?.[target.criterion] ?? null,
      gradings: graded.rawAnswers.map((answer) => ({
        verdict: parseVerdicts(answer, criteria.length)?.[target.criterion] ?? null,
        reasons: graderReasons(answer),
      })),
    };
  }

  async function classify(target: Target, samples: Sample[]): Promise<TriageItem> {
    const item = {
      skill: target.suite.name,
      scenario: target.scenario.id,
      criterion: target.scenario.criteria[target.criterion] as string,
      model: target.label,
    };
    const errors = samples.flatMap((s) => ('error' in s ? [s.error] : []));
    if (errors.length === samples.length) {
      return {
        ...item,
        proposed: 'unclassified',
        reason: `no sample could be generated: ${errors[0]}`,
      };
    }
    let answer: string;
    try {
      answer = await call(classifierOf(target), classificationPrompt(target, samples));
    } catch (error) {
      if (isConfigProblem(error)) throw error;
      return {
        ...item,
        proposed: 'unclassified',
        reason: `the classification call failed: ${messageOf(error)}`,
      };
    }
    const parsed = parseClassification(answer);
    return parsed
      ? { ...item, ...parsed }
      : {
          ...item,
          proposed: 'unclassified',
          reason: 'the classification could not be parsed',
          rawAnswer: answer,
        };
  }

  const triaged: Triaged[] = await Promise.all(
    targets.map(async (target) => {
      const prompt = fillTemplate(
        config.withSkillTemplate,
        target.suite.skillText,
        target.scenario.prompt,
      );
      const samples = await Promise.all(
        Array.from({ length: sampleCount }, () => sample(target, prompt)),
      );
      const item = await classify(target, samples);
      log(`  [${item.scenario}] ${item.model} "${item.criterion}": ${item.proposed}`);
      return { target, samples, item };
    }),
  );

  await writeFile(
    reportPath,
    renderTriage(triaged, notes, {
      run: run.name,
      samples: sampleCount,
      gradings: config.gradings,
      grader: config.grader,
      classifier: config.triage.model,
    }),
  );
  return { reportPath, items: triaged.map((t) => t.item) };
}

/**
 * Reads the classification from the triage model's reply: the last `CLASSIFICATION:` line, with
 * a `REASON:` line after it (the last one). Markdown around a label or a value is ignored
 * (`**CLASSIFICATION:** *Grader Error*`, `- Reason: ...`, quotes, a trailing period), as are
 * case and hyphens in the category, and words after it (`grader error — it calls map`). Returns
 * `null` unless the category is one of the four and the reason is not empty.
 */
export function parseClassification(
  answer: string,
): { proposed: TriageCategory; reason: string } | null {
  const lines = answer.split(/\r?\n/);
  const at = lastIndex(lines, (line) => labelled('classification', line) !== null);
  if (at === -1) return null;

  const value = (labelled('classification', lines[at] as string) as string)
    .replace(/[*_`"'“”]/g, '')
    .replace(/[\s-]+/g, ' ')
    .trim()
    .toLowerCase();
  const proposed = TRIAGE_CATEGORIES.find(
    (category) => value === category || new RegExp(`^${category}(?![a-z])`).test(value),
  );

  const after = lines.slice(at + 1);
  const reasonAt = lastIndex(after, (line) => labelled('reason', line) !== null);
  const reason = reasonAt === -1 ? '' : (labelled('reason', after[reasonAt] as string) as string);
  const trimmed = reason.replace(/^[\s*_]+|[\s*_]+$/g, '');
  return proposed && trimmed ? { proposed, reason: trimmed } : null;
}

/** The value after `<label>:` on a line, with markdown allowed around the label; else `null`. */
function labelled(label: string, line: string): string | null {
  const match = new RegExp(`^[\\s#*>_-]*${label}[\\s*_]*:[\\s*_]*(.*)$`, 'i').exec(line);
  return match ? (match[1] as string) : null;
}

function lastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i] as T)) return i;
  return -1;
}

/** The newest results directory with a `summary.json`, and that summary. */
async function latestRun(
  results: string,
): Promise<{ name: string; dir: string; summary: RunSummary }> {
  let names: string[] = [];
  try {
    names = await readdir(results);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of names.filter((n) => RUN_DIR.test(n)).sort().reverse()) {
    const dir = path.join(results, name);
    const file = path.join(dir, 'summary.json');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`${file}: invalid JSON (${(error as Error).message})`);
    }
    if (typeof data !== 'object' || data === null || !Array.isArray((data as RunSummary).skills)) {
      throw new ConfigError(`${file}: not a skill-be summary (no "skills" list)`);
    }
    return { name, dir, summary: data as RunSummary };
  }
  throw new ConfigError(
    `no run with a summary.json in ${results}: run \`skill-be run\` before triage`,
  );
}

/**
 * The failures of the given suites in a run summary, in suite, scenario, criterion and model
 * order, and a note for each skill or failure that is not triaged.
 */
function selectTargets(
  summary: RunSummary,
  suites: readonly SkillSuite[],
  models: readonly AdapterSettings[],
  below: number | undefined,
): { targets: Target[]; notes: string[] } {
  const labels = modelLabels(models);
  const targets: Target[] = [];
  const notes: string[] = [];

  for (const suite of suites) {
    const skill = summary.skills.find((s) => s.skill === suite.name);
    if (!skill) {
      notes.push(`\`${suite.name}\`: not in this run.`);
      continue;
    }
    const errors = skill.blocks.filter((block) => block.kind === 'error').length;
    if (errors > 0) {
      notes.push(
        `\`${suite.name}\`: the error block (${skill.errorCount} output(s) could not be ` +
          'generated or graded) names no criterion and is not triaged; see the notes of the run.',
      );
    }

    const causes = failureCauses(skill, below);
    for (const summaryScenario of skill.scenarios) {
      summaryScenario.criteria.forEach((criterionText, c) => {
        for (const model of summaryScenario.models) {
          const why = causes.get(key(summaryScenario.id, c, model.model));
          if (!why) continue;
          const where = `\`${suite.name}\` / \`${summaryScenario.id}\` / ${model.model}`;
          const scenario = suite.scenarios.find((s) => s.id === summaryScenario.id);
          const criterion = scenario?.criteria.indexOf(criterionText) ?? -1;
          const m = labels.indexOf(model.model);
          if (!scenario) {
            notes.push(`${where}: the eval file no longer has this scenario; not triaged.`);
          } else if (criterion === -1) {
            notes.push(
              `${where}: the eval file no longer has the criterion "${criterionText}"; ` +
                'not triaged.',
            );
          } else if (m === -1) {
            notes.push(`${where}: the config no longer has this model; not triaged.`);
          } else {
            targets.push({
              suite,
              scenario,
              criterion,
              label: model.model,
              settings: models[m] as AdapterSettings,
              causes: why,
              score: model.criteria[c] ?? { baselinePct: 0, withSkillPct: 0 },
            });
          }
        }
      });
    }
  }
  return { targets, notes };
}

/** Why each (scenario, criterion, model) of a skill is triaged, keyed by {@link key}. */
function failureCauses(skill: SkillSummary, below: number | undefined): Map<string, string[]> {
  const causes = new Map<string, string[]>();
  const add = (scenario: string, criterion: number, model: string, cause: string): void => {
    const k = key(scenario, criterion, model);
    causes.set(k, [...(causes.get(k) ?? []), cause]);
  };

  for (const block of skill.blocks) {
    const scenario = skill.scenarios.find((s) => s.id === block.scenario);
    if (!scenario || block.criterion === undefined) continue;
    const c = block.criterion;
    if (block.kind === 'zero') {
      for (const model of scenario.models) {
        add(scenario.id, c, model.model, 'blocked (universal 0%)');
      }
    } else if (block.kind === 'regression' && block.model !== undefined) {
      add(scenario.id, c, block.model, 'blocked (regression)');
    }
  }

  if (below !== undefined) {
    for (const scenario of skill.scenarios) {
      for (const model of scenario.models) {
        model.criteria.forEach((score, c) => {
          if (score.withSkillPct < below) {
            add(scenario.id, c, model.model, `under ${below}% with the skill`);
          }
        });
      }
    }
  }
  return causes;
}

function key(scenario: string, criterion: number, model: string): string {
  return JSON.stringify([scenario, criterion, model]);
}

const verdictText = (verdict: 0 | 1 | null): string =>
  verdict === null ? 'no verdict' : verdict ? 'YES' : 'NO';

/** The prompt that asks the triage model for a classification and a one-line reason. */
function classificationPrompt(target: Target, samples: readonly Sample[]): string {
  const { scenario, criterion } = target;
  const n = criterion + 1;
  const parts: string[] = [
    'You are triaging a failure in a benchmark of an Agent Skill. The skill is documentation ' +
      'given to a model in its prompt; the model then answers a task, and a grader model ' +
      'judges the answer against numbered criteria. One criterion keeps failing with the ' +
      'skill. Below are the skill, the task, the criteria, and fresh answers written with the ' +
      "skill, each with the grader's verdict on that criterion and the grader's reasons.",
    '',
    'Classify the failure into exactly one of these categories:',
    ...TRIAGE_CATEGORIES.map((category) => `- ${category}: ${DEFINITIONS[category]};`),
    '',
    `<skill>\n${target.suite.skillText}\n</skill>`,
    '',
    `<task>\n${scenario.prompt}\n</task>`,
    '',
    `Criteria (the grader judged them together):\n` +
      scenario.criteria.map((text, i) => `${i + 1}. ${text}`).join('\n'),
    '',
    `The failing criterion is number ${n}: "${scenario.criteria[criterion]}"`,
    `In the benchmark run, ${target.label} met it in ${target.score.baselinePct}% of the ` +
      `answers without the skill and in ${target.score.withSkillPct}% with it.`,
  ];

  samples.forEach((sample, i) => {
    if ('error' in sample) return;
    parts.push(
      '',
      `<sample number="${i + 1}" ` +
        `grader-verdict-on-criterion-${n}="${verdictText(sample.verdict)}">`,
      `<answer>\n${sample.output}\n</answer>`,
      ...sample.gradings.map(
        (grading, k) =>
          `<grader-reasons grading="${k + 1}" verdict="${verdictText(grading.verdict)}">\n` +
          `${grading.reasons}\n</grader-reasons>`,
      ),
      '</sample>',
    );
  });

  parts.push(
    '',
    `Check the answer against criterion ${n} yourself before trusting the grader. Then end your ` +
      'reply with exactly these two lines and nothing after them:',
    `CLASSIFICATION: <one of: ${TRIAGE_CATEGORIES.join(', ')}>`,
    'REASON: <one line saying why, citing the answer>',
  );
  return parts.join('\n');
}

type RenderInfo = {
  run: string;
  samples: number;
  gradings: number;
  grader: AdapterSettings;
  /** `triage.model`; `null` means each failure is classified by its own model under test. */
  classifier: AdapterSettings | null;
};

/** The markdown triage report: the proposals, what was not triaged, then each failure in full. */
function renderTriage(
  triaged: readonly Triaged[],
  notes: readonly string[],
  info: RenderInfo,
): string {
  const out: string[] = [];
  out.push(`# Triage of run ${info.run}`);
  out.push('');
  out.push(
    'Proposed classifications of the failing criteria, for a human to confirm. ' +
      'Triage never blocks a release.',
  );
  out.push('');
  out.push(
    `Method: ${info.samples} fresh with-skill sample(s) per failure, each graded ` +
      `${info.gradings} time(s) by ${info.grader.id} (via ${info.grader.adapter}); ` +
      (info.classifier
        ? `classified by ${info.classifier.id} (via ${info.classifier.adapter}).`
        : 'classified by the model under test whose output failed.'),
  );
  out.push('');

  if (triaged.length === 0) {
    out.push('No failing criteria to triage.');
    out.push('');
  } else {
    out.push('| Skill | Scenario | Model | Criterion | Proposed |');
    out.push('|-------|----------|-------|-----------|----------|');
    for (const { item } of triaged) {
      out.push(
        `| ${cell(item.skill)} | ${cell(item.scenario)} | ${cell(item.model)} | ` +
          `${cell(item.criterion)} | ${item.proposed} |`,
      );
    }
    out.push('');
  }

  if (notes.length > 0) {
    out.push('## Not triaged');
    out.push('');
    for (const note of notes) out.push(`- ${note}`);
    out.push('');
  }

  for (const { target, samples, item } of triaged) {
    out.push(`## \`${item.skill}\` / \`${item.scenario}\` / ${item.model}`);
    out.push('');
    out.push(`Criterion ${target.criterion + 1}: *"${item.criterion}"*`);
    out.push('');
    out.push(
      `Why: ${target.causes.join('; ')}. In the run: baseline ${target.score.baselinePct}%, ` +
        `with skill ${target.score.withSkillPct}%.`,
    );
    out.push('');
    out.push(`Task: *${target.scenario.prompt}*`);
    out.push('');
    if (item.proposed === 'unclassified') {
      out.push(`**Unclassified** — ${item.reason}`);
      if (item.rawAnswer !== undefined) {
        out.push('');
        out.push('Raw answer of the triage model:');
        out.push('');
        out.push(fenced(item.rawAnswer));
      }
    } else {
      out.push(`**Proposed: ${item.proposed}** — ${item.reason}`);
    }
    out.push('');

    samples.forEach((sample, i) => {
      if ('error' in sample) {
        out.push(`### Sample ${i + 1} — generation failed`);
        out.push('');
        out.push(`[ERROR] ${sample.error}`);
        out.push('');
        return;
      }
      out.push(`### Sample ${i + 1} — grader: ${verdictText(sample.verdict)}`);
      out.push('');
      out.push(fenced(sample.output));
      out.push('');
      sample.gradings.forEach((grading, k) => {
        out.push(`Grader reasons, grading ${k + 1} (${verdictText(grading.verdict)}):`);
        out.push('');
        out.push(fenced(grading.reasons));
        out.push('');
      });
    });
  }

  return `${out.join('\n')}\n`;
}

/** `text` in a code fence longer than any run of backticks inside it, so it cannot close early. */
function fenced(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text.replace(/\r\n/g, '\n').trimEnd()}\n${fence}`;
}

/** An error message on one line. */
function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
}
