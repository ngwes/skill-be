import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Option, TryAsync, repeatWhile } from '@ngwes/mini-fp';
import { isConfigProblem, resolveAdapter, type Adapter } from './adapters/index.js';
import { gradeOutput, type Verdicts } from './grader.js';
import { createLimiter } from './limiter.js';
import type { AdapterSettings, Config, Scenario, SkillSuite } from './types.js';

/** One criterion's share of YES verdicts over the reps, as a rounded percentage per arm. */
export type CriterionScore = { baselinePct: number; withSkillPct: number };

export type ModelResult = {
  /** The model's label: its id, or `adapter:id` when several models under test share the id. */
  model: string;
  /** One score per criterion, in criterion order. */
  criteria: CriterionScore[];
  /** `[ERROR] ...` notes first, then `[NOTE] ...` notes, each naming the rep and arm. */
  notes: string[];
  /** Outputs that could not be generated or graded; their criteria counted as 0. */
  errors: number;
};

export type ScenarioResult = { scenario: Scenario; models: ModelResult[] };

export type SkillRun = {
  skill: string;
  /** In eval file order, each with its models in config order. */
  scenarios: ScenarioResult[];
  errorCount: number;
  /** ISO time the run started. */
  startedAt: string;
  durationMs: number;
};

export type RunDeps = {
  /** Resolves an entry's adapter; `resolveAdapter` against the config root by default. */
  adapterFor?: (settings: AdapterSettings) => Promise<Adapter>;
  /** Receives one progress line at a time; stderr by default. */
  log?: (line: string) => void;
  /**
   * The results subdirectory, `<results>/<timestamp>/<skill>/...`, so several skills of one run
   * share it. A new {@link resultsTimestamp} by default.
   */
  timestamp?: string;
};

/** The arms, by their name in file names. */
const ARMS = ['baseline', 'with-skill'] as const;

type Arm = (typeof ARMS)[number];

/** How progress lines and notes name each arm, as run-benchmark.mjs does. */
const ARM_LABELS: Record<Arm, string> = { baseline: 'baseline', 'with-skill': 'with skill' };

/** A model under test with its resolved adapter, its label and its results directory name. */
type Model = { settings: AdapterSettings; adapter: Adapter; label: string; dir: string };

/** One graded output: its verdicts (`null` when it counts as an error) and its notes. */
type OutputResult = { verdicts: Verdicts | null; notes: string[] };

/**
 * Runs the benchmark of one skill: for every scenario and every model under test, `reps`
 * generations per arm (baseline and with skill), each graded `gradings` times. Every generation
 * and grading call goes through one limiter of `config.concurrency`.
 *
 * Writes each output to `<results>/<timestamp>/<skill>/<scenario>/<model>/rep-<n>-<arm>.md` and
 * each raw grader answer beside it as `rep-<n>-<arm>.grading-<k>.md`. An output that could not
 * be generated or graded counts its criteria as 0, carries an `[ERROR]` note and adds to
 * `errorCount`; what that means for the verdict is the gate's business. A `ConfigError` an
 * adapter throws, or a CLI that cannot start, is not an output error: it rejects `runSkill`, so
 * the CLI can exit with 2 (see `isConfigProblem`).
 */
export async function runSkill(
  suite: SkillSuite,
  config: Config,
  deps: RunDeps = {},
): Promise<SkillRun> {
  const started = Date.now();
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const adapterFor =
    deps.adapterFor ??
    ((settings: AdapterSettings) => resolveAdapter(settings.adapter, config.root));
  const runDir = path.join(
    config.results,
    deps.timestamp ?? resultsTimestamp(new Date(started)),
    suite.name,
  );

  // Resolve every adapter before the first call, so a config error stops the run at once.
  const modelAdapters = await Promise.all(config.models.map((settings) => adapterFor(settings)));
  const graderAdapter = await adapterFor(config.grader);

  const limit = createLimiter(config.concurrency);
  const timeoutMs = config.timeoutSeconds * 1000;
  const call = (adapter: Adapter, settings: AdapterSettings, prompt: string): Promise<string> =>
    limit(() => adapter(prompt, { settings, timeoutMs, cwd: config.root }));
  const grade = (prompt: string): Promise<string> => call(graderAdapter, config.grader, prompt);

  const labels = modelLabels(config.models);
  const modelDirs = uniqueSegments(labels);
  const models: Model[] = config.models.map((settings, i) => ({
    settings,
    adapter: modelAdapters[i] as Adapter,
    label: labels[i] as string,
    dir: modelDirs[i] as string,
  }));
  const scenarioDirs = uniqueSegments(suite.scenarios.map((scenario) => scenario.id));
  const totalReps = suite.scenarios.length * models.length * config.reps;
  let doneReps = 0;

  log(
    `${suite.name}: ${suite.scenarios.length} scenarios × ${models.length} model(s) × ` +
      `${config.reps} reps, concurrency ${config.concurrency}`,
  );

  /** Generates one output, writes it, grades it and writes the grader's answers. */
  async function runOutput(
    scenario: Scenario,
    model: Model,
    prompt: string,
    file: string,
    tag: string,
  ): Promise<OutputResult> {
    const t0 = Date.now();
    return TryAsync.runAsync(() => call(model.adapter, model.settings, prompt)).match(
      async (output) => {
        await writeFile(`${file}.md`, output);

        const graded = await gradeOutput(
          scenario.criteria,
          output,
          grade,
          config.gradings,
          config.graderPrompt ?? undefined,
        );
        await Promise.all(
          graded.rawAnswers.map((answer, k) => writeFile(`${file}.grading-${k + 1}.md`, answer)),
        );
        const outcome = Option.from(graded.verdicts).match(
          (verdicts) => `${verdicts.reduce<number>((sum, v) => sum + v, 0)}/${verdicts.length} YES`,
          () => 'grading FAILED',
        );
        log(`  ${tag}: ${outcome} (${seconds(Date.now() - t0)})`);
        return { verdicts: graded.verdicts, notes: graded.notes };
      },
      async (error) => {
        // A config problem is the user's to fix: it stops the run (exit 2), not an output error.
        if (isConfigProblem(error)) throw error;
        const message = oneLine(error instanceof Error ? error.message : String(error));
        await writeFile(`${file}.md`, `[ERROR: ${message}]\n`);
        log(`  ${tag}: generation failed — ${message.slice(0, 200)}`);
        return {
          verdicts: null,
          notes: [`[ERROR] generation failed, criteria counted as 0: ${message}`],
        };
      },
    );
  }

  /** Both arms of one rep, run side by side. */
  async function runRep(
    scenario: Scenario,
    model: Model,
    dir: string,
    rep: number,
  ): Promise<Record<Arm, OutputResult>> {
    const label = `[${scenario.id}] ${model.label} rep ${rep}/${config.reps}`;
    const arm = (name: Arm, prompt: string): Promise<OutputResult> =>
      runOutput(
        scenario,
        model,
        prompt,
        path.join(dir, `rep-${rep}-${name}`),
        `${label} ${ARM_LABELS[name]}`,
      );
    const [baseline, withSkill] = await Promise.all([
      arm('baseline', scenario.prompt),
      arm('with-skill', fillTemplate(config.withSkillTemplate, suite.skillText, scenario.prompt)),
    ]);
    doneReps++;
    log(
      `  ${label} done (${doneReps}/${totalReps} reps, ` +
        `${seconds(Date.now() - started)} elapsed)`,
    );
    return { baseline, 'with-skill': withSkill };
  }

  /** Every rep of one model on one scenario, scored per criterion. */
  async function runModel(
    scenario: Scenario,
    scenarioDir: string,
    model: Model,
  ): Promise<ModelResult> {
    const dir = path.join(runDir, scenarioDir, model.dir);
    await mkdir(dir, { recursive: true });
    const reps = await Promise.all(
      Array.from({ length: config.reps }, (_, r) => runRep(scenario, model, dir, r + 1)),
    );

    const pct = (arm: Arm, criterion: number): number => {
      const yes = reps.reduce((sum, rep) => sum + (rep[arm].verdicts?.[criterion] ?? 0), 0);
      return Math.round((yes / config.reps) * 100);
    };
    const notes = reps.flatMap((rep, r) =>
      ARMS.flatMap((arm) =>
        rep[arm].notes.map((note) => inContext(note, `rep ${r + 1} ${ARM_LABELS[arm]}`)),
      ),
    );
    return {
      model: model.label,
      criteria: scenario.criteria.map((_, c) => ({
        baselinePct: pct('baseline', c),
        withSkillPct: pct('with-skill', c),
      })),
      // Errors first, as run-benchmark.mjs lists them.
      notes: [
        ...notes.filter((note) => note.startsWith('[ERROR]')),
        ...notes.filter((note) => !note.startsWith('[ERROR]')),
      ],
      errors: reps.reduce(
        (sum, rep) => sum + ARMS.filter((arm) => rep[arm].verdicts === null).length,
        0,
      ),
    };
  }

  const scenarios: ScenarioResult[] = await Promise.all(
    suite.scenarios.map(async (scenario, s) => ({
      scenario,
      models: await Promise.all(
        models.map((model) => runModel(scenario, scenarioDirs[s] as string, model)),
      ),
    })),
  );

  const errorCount = scenarios.reduce(
    (sum, result) => sum + result.models.reduce((n, model) => n + model.errors, 0),
    0,
  );
  const durationMs = Date.now() - started;
  log(
    `${suite.name}: finished in ${seconds(durationMs)}` +
      `${errorCount ? `, ${errorCount} error(s)` : ''}`,
  );

  return {
    skill: suite.name,
    scenarios,
    errorCount,
    startedAt: new Date(started).toISOString(),
    durationMs,
  };
}

/**
 * One label per model under test: its id, or `adapter:id` when another entry has the same id.
 * Entries that share both are numbered (`adapter:id#1`, `adapter:id#2`) so labels stay unique.
 */
export function modelLabels(models: readonly AdapterSettings[]): string[] {
  const named = models.map((model) =>
    models.filter((other) => other.id === model.id).length > 1
      ? `${model.adapter}:${model.id}`
      : model.id,
  );
  return named.map((label, i) =>
    named.filter((other) => other === label).length > 1
      ? `${label}#${named.slice(0, i + 1).filter((other) => other === label).length}`
      : label,
  );
}

/** A filesystem-safe ISO time for the results directory: `2026-10-31T09-05-03-042Z`. */
export function resultsTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** The template with `{{skill}}` and `{{task}}` filled in one pass, so neither text is re-read. */
export function fillTemplate(template: string, skill: string, task: string): string {
  return template.replace(/\{\{(skill|task)\}\}/g, (_, key: string) =>
    key === 'skill' ? skill : task,
  );
}

/** `[LEVEL] text` -> `[LEVEL] <context> — text`, as run-benchmark.mjs names the rep and arm. */
function inContext(note: string, context: string): string {
  return note.replace(/^(\[(?:ERROR|NOTE)\]) /, (_, level: string) => `${level} ${context} — `);
}

/**
 * Directory names for labels or ids: characters that Windows or POSIX paths forbid become `_`,
 * and so do trailing dots and spaces, which Windows drops (this also covers `.` and `..`). A name
 * that then repeats an earlier one, ignoring case as Windows does, gets `-2`, `-3`, ...
 */
function uniqueSegments(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '_') || '_';
    const { unique } = repeatWhile(
      () => ({ unique: safe, next: 2 }),
      (candidate) => used.has(candidate.unique.toLowerCase()),
      ({ next }) => ({ unique: `${safe}-${next}`, next: next + 1 }),
    );
    used.add(unique.toLowerCase());
    return unique;
  });
}

/** An error message on one line, so it fits in a note and a markdown list item. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
