#!/usr/bin/env node
/**
 * The `skill-be` command: `run`, `verify`, `check` and `triage`. `main` returns the exit code: 0
 * when every skill is READY and every blocking check passes, 1 when anything blocks, 2 for a
 * usage or config error. Only the entry point at the bottom exits the process.
 */

import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Option, Try, TryAsync } from '@ngwes/mini-fp';
import { isConfigProblem } from './adapters/index.js';
import { coverage, validateCoverage } from './checks/coverage.js';
import { typecheckSkill, validateTypecheck } from './checks/typecheck.js';
import { loadConfig } from './config.js';
import { skillFingerprint } from './fingerprint.js';
import { evaluateGate, type GateVerdict } from './gate.js';
import { killActiveChildren } from './process.js';
import { renderReport, toSummary } from './report.js';
import {
  mergeResults,
  readResultFile,
  skillBeVersion,
  verifyResults,
  writeResultFile,
  type SkillEntry,
} from './result-file.js';
import { modelLabels, resultsTimestamp, runSkill, type SkillRun } from './runner.js';
import { loadSuites } from './suite.js';
import { triage, type TriageOptions } from './triage.js';
import { ConfigError, type Config, type SkillSuite } from './types.js';

export type Writer = { write(text: string): unknown };

export type Io = { stdout: Writer; stderr: Writer; cwd: string };

const USAGE = `Usage: skill-be <command> [options]

Benchmarks Agent Skills: baseline versus with-skill, LLM-graded and gated.

Commands:
  run [skill...]     Benchmark every skill that has an eval file, or the named ones. Writes
                     the outputs, the grader answers, a report per skill and summary.json
                     under the results directory, updates the result file, then runs the checks.
  verify             Without a model call: checks that the result file matches the current
                     skills, evals and config and records every skill READY, then runs the checks.
  check              Runs the typecheck and coverage checks.
  triage [skill...]  Proposes a classification for each failing criterion of the latest run.
                     Never blocks.

Options:
  --config <path>    The config file (default: ./skill-be.yaml)
  --reps <n>         run: generations per arm per scenario, instead of the config's
  --concurrency <n>  run: model calls in flight at once, instead of the config's
  --below <pct>      triage: also triage criteria that scored under pct% with the skill
  --samples <n>      triage: fresh with-skill samples per failing criterion (default: 2)
  -h, --help         Shows this help

Exit codes: 0 when every skill is READY and every blocking check passes, 1 when anything
blocks, 2 for a usage or config error.
`;

/** A mistake on the command line (exit code 2, with a pointer to the help). */
class UsageError extends Error {
  override name = 'UsageError';
}

type CommandName = 'run' | 'verify' | 'check' | 'triage';

type Args = { command: CommandName; skills: string[]; options: Map<string, string> };

/** What each command accepts: its options (without `--`) and whether it takes skill names. */
const SYNTAX: Record<CommandName, { options: string[]; skills: boolean }> = {
  run: { options: ['config', 'reps', 'concurrency'], skills: true },
  verify: { options: ['config'], skills: false },
  check: { options: ['config'], skills: false },
  triage: { options: ['config', 'below', 'samples'], skills: true },
};

/** What a command prints with and where it is run from. */
type Context = {
  /** Writes text to stdout as it is. */
  write: (text: string) => void;
  out: (line?: string) => void;
  err: (line: string) => void;
  /** A path as the user reads it: relative to the working directory when it is inside it. */
  show: (file: string) => string;
  cwd: string;
};

const COMMANDS: Record<CommandName, (args: Args, ctx: Context) => Promise<number>> = {
  run: runCommand,
  verify: verifyCommand,
  check: checkCommand,
  triage: triageCommand,
};

/** Runs the command `argv` names (without the node and script paths) and returns its exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const err = (line: string): void => void io.stderr.write(`${line}\n`);
  return TryAsync.runAsync(async () => {
    const args = parseArgs(argv);
    if (args === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    return COMMANDS[args.command](args, {
      write: (text) => void io.stdout.write(text),
      out: (line = '') => void io.stdout.write(`${line}\n`),
      err,
      show: (file) => {
        const relative = path.relative(io.cwd, file);
        const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
        return inside ? relative : file;
      },
      cwd: io.cwd,
    });
  }).onFail((error) => {
    if (error instanceof UsageError) {
      err(`skill-be: ${error.message}`);
      err('Run "skill-be --help" for usage.');
      return 2;
    }
    // A config error, or a CLI that could not start: the user's to fix, not a skill's verdict.
    if (isConfigProblem(error)) {
      err(`skill-be: ${(error as Error).message}`);
      return 2;
    }
    err(`skill-be: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  });
}

function parseArgs(argv: string[]): Args | 'help' {
  if (argv[0] === 'help' || argv.some((arg) => arg === '--help' || arg === '-h')) return 'help';

  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError('no command given');
  if (!Object.prototype.hasOwnProperty.call(SYNTAX, command)) {
    throw new UsageError(`unknown command "${command}" (commands: run, verify, check, triage)`);
  }
  const name = command as CommandName;
  const syntax = SYNTAX[name];

  const skills: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith('-')) {
      skills.push(arg);
      continue;
    }
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(arg);
    const key = match?.[1];
    if (key === undefined || !syntax.options.includes(key)) {
      throw new UsageError(`unknown option ${arg.split('=')[0]} for "${name}"`);
    }
    // `--key=value`, or `--key value`; a value may start with "-" (`--below -1` is then rejected
    // as out of range), but not with "--", which is the next option.
    const value = match?.[2] ?? rest[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`--${key} needs a value`);
    }
    options.set(key, value);
  }
  if (!syntax.skills && skills.length > 0) {
    throw new UsageError(`${name} takes no skill names (got ${skills.join(' ')})`);
  }
  return { command: name, skills, options };
}

/** The option's value; none when it is not given, a `UsageError` when it is not a valid one. */
function positiveInteger(args: Args, key: string): Option<number> {
  return Option.from(args.options.get(key)).map((raw) => {
    const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
      throw new UsageError(`--${key} must be a positive integer (got "${raw}")`);
    }
    return value;
  });
}

/** The option's value; none when it is not given, a `UsageError` when it is not a valid one. */
function percentage(args: Args, key: string): Option<number> {
  return Option.from(args.options.get(key)).map((raw) => {
    const value = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || value > 100) {
      throw new UsageError(`--${key} must be a number from 0 to 100 (got "${raw}")`);
    }
    return value;
  });
}

type Project = {
  config: Config;
  /** Every skill with an eval file: the checks always cover all of them. */
  all: SkillSuite[];
  /** The skills named on the command line, else all of them. */
  selected: SkillSuite[];
};

/**
 * Loads the config and the suites, and prints the warnings about the selected skills. Having no
 * skill to work on is a config error: it never passes silently.
 */
async function loadProject(args: Args, ctx: Context): Promise<Project> {
  const configPath = path.resolve(
    ctx.cwd,
    Option.from(args.options.get('config')).orElse('skill-be.yaml'),
  );
  const config = await loadConfig(configPath);
  const all = await loadSuites(config);
  const selected = args.skills.length > 0 ? await loadSuites(config, args.skills) : all;
  for (const warning of selected.warnings) ctx.err(`warning: ${warning}`);
  if (selected.suites.length === 0) {
    const which = args.skills.length > 0 ? `none of ${args.skills.join(', ')} has` : 'no skill has';
    throw new ConfigError(
      `no skill to ${args.command}: ${which} a SKILL.md in ${config.skills} ` +
        `and an eval file in ${config.evals}`,
    );
  }
  return { config, all: all.suites, selected: selected.suites };
}

/** Throws the `ConfigError` a misconfigured check would throw, without running the checks. */
async function validateChecks(config: Config): Promise<void> {
  const { typecheck, coverage: coverageConfig } = config.checks;
  if (typecheck !== false) await validateTypecheck(typecheck, config.root);
  if (coverageConfig !== false) await validateCoverage(coverageConfig, config.root);
}

/** The checks' output lines, and what they block on (empty when nothing blocks). */
type ChecksOutcome = { lines: string[]; blockers: string[] };

/** Runs the typecheck and the coverage check, when the config enables them, over `suites`. */
async function runChecks(config: Config, suites: SkillSuite[]): Promise<ChecksOutcome> {
  const lines: string[] = [];
  const blockers: string[] = [];

  const typecheck = config.checks.typecheck;
  if (typecheck === false) {
    lines.push('typecheck: off');
  } else {
    const problems: string[] = [];
    const warnings: string[] = [];
    for (const suite of suites) {
      const result = await typecheckSkill(suite, typecheck, config.root);
      problems.push(...result.problems);
      warnings.push(...result.warnings);
    }
    if (problems.length === 0) {
      lines.push(`typecheck: passed (${suites.length} skill(s))`);
    } else {
      const blocks = typecheck.blocking ? '' : ', not blocking';
      lines.push(`typecheck: ${problems.length} problem(s)${blocks}`);
      if (typecheck.blocking) blockers.push('the typecheck');
    }
    lines.push(...problems.map((problem) => `  - ${problem}`));
    lines.push(...warnings.map((warning) => `  warning: ${warning}`));
  }

  const coverageConfig = config.checks.coverage;
  if (coverageConfig === false) {
    lines.push('coverage: off');
  } else {
    const { missing, blocking } = await coverage(suites, coverageConfig, config.root);
    if (missing.length === 0) {
      lines.push('coverage: every API name is mentioned');
    } else {
      lines.push(
        `coverage: ${missing.length} API name(s) not mentioned in any SKILL.md or eval file` +
          `${blocking ? '' : ', not blocking'}: ${missing.join(', ')}`,
      );
      if (blocking) blockers.push('the coverage');
    }
  }
  return { lines, blockers };
}

/** The last line of a command's output, and its exit code. */
function conclude(ctx: Context, blockers: string[]): number {
  ctx.out(blockers.length === 0 ? 'Result: pass' : `Result: blocked by ${blockers.join(', ')}`);
  return blockers.length === 0 ? 0 : 1;
}

async function runCommand(args: Args, ctx: Context): Promise<number> {
  const reps = positiveInteger(args, 'reps');
  const concurrency = positiveInteger(args, 'concurrency');
  const project = await loadProject(args, ctx);
  const config: Config = {
    ...project.config,
    reps: reps.orElse(project.config.reps),
    concurrency: concurrency.orElse(project.config.concurrency),
  };

  // Before the first model call: a broken result file or check setting must not cost a run.
  const existing = await readResultFile(config.resultFile);
  await validateChecks(config);
  const version = await skillBeVersion();
  // The files as the run reads them, before a long run gives anyone time to edit them.
  const fingerprints = await Promise.all(
    project.selected.map((suite) => skillFingerprint(config, suite)),
  );

  const timestamp = resultsTimestamp();
  const runDir = path.join(config.results, timestamp);
  const summaryPath = path.join(runDir, 'summary.json');
  const runs: SkillRun[] = [];
  const gates = new Map<string, GateVerdict>();
  const entries: Record<string, SkillEntry> = {};
  const reports: string[] = [];

  for (const [i, suite] of project.selected.entries()) {
    const run = await runSkill(suite, config, { log: ctx.err, timestamp });
    const gate = evaluateGate(run, config.gate);
    runs.push(run);
    gates.set(run.skill, gate);
    const date = run.startedAt.slice(0, 10);

    const report = renderReport(run, gate, {
      models: config.models,
      grader: config.grader,
      reps: config.reps,
      gradings: config.gradings,
      date,
    });
    const reportPath = path.join(runDir, `${suite.name}.md`);
    await mkdir(runDir, { recursive: true });
    await writeFile(reportPath, report);
    reports.push(reportPath);
    ctx.write(report);

    // Written after every skill, so an interrupted run keeps what it finished.
    await writeFile(summaryPath, JSON.stringify(toSummary(runs, gates), null, 2) + '\n');
    entries[suite.name] = {
      date,
      fingerprint: fingerprints[i] as string,
      ready: gate.ready,
      reasons: gate.reasons,
      models: modelLabels(config.models),
      grader: config.grader.id,
    };
    await writeResultFile(
      config.resultFile,
      mergeResults(existing, { skillBeVersion: version, skills: entries }),
    );
  }

  const checks = await runChecks(config, project.all);

  ctx.out('Skills:');
  for (const run of runs) {
    const gate = gates.get(run.skill) as GateVerdict;
    const reasons = gate.reasons.length;
    ctx.out(`  ${run.skill}: ${gate.ready ? 'READY' : `NOT READY (${reasons} reason(s))`}`);
  }
  for (const line of checks.lines) ctx.out(line);
  ctx.out('Written:');
  for (const file of [...reports, summaryPath, config.resultFile]) ctx.out(`  ${ctx.show(file)}`);

  const notReady = runs.filter((run) => !gates.get(run.skill)?.ready);
  const blockers = [
    ...notReady.map((run) => `skill "${run.skill}" NOT READY`),
    ...checks.blockers,
  ];
  return conclude(ctx, blockers);
}

async function verifyCommand(args: Args, ctx: Context): Promise<number> {
  const { config, all } = await loadProject(args, ctx);
  const file = await readResultFile(config.resultFile);
  const { ok, problems } = await verifyResults(config, all, file);
  const checks = await runChecks(config, all);

  const where = `result file ${ctx.show(config.resultFile)}`;
  ctx.out(
    ok
      ? `${where}: ${all.length} skill(s) match their last run, every one READY`
      : `${where}: ${problems.length} problem(s)`,
  );
  for (const problem of problems) ctx.out(`  - ${problem}`);
  for (const line of checks.lines) ctx.out(line);
  return conclude(ctx, [...(ok ? [] : ['the result file']), ...checks.blockers]);
}

async function checkCommand(args: Args, ctx: Context): Promise<number> {
  const { config, all } = await loadProject(args, ctx);
  const checks = await runChecks(config, all);
  for (const line of checks.lines) ctx.out(line);
  return conclude(ctx, checks.blockers);
}

async function triageCommand(args: Args, ctx: Context): Promise<number> {
  const below = percentage(args, 'below');
  const samples = positiveInteger(args, 'samples');
  const { config, selected } = await loadProject(args, ctx);

  const options: TriageOptions = { deps: { log: ctx.err } };
  below.onSome((value) => (options.below = value));
  samples.onSome((value) => (options.samples = value));
  const { reportPath, items } = await triage(config, selected, options);

  ctx.out(`Triage: ${items.length} failure(s)`);
  for (const item of items) {
    ctx.out(
      `  ${item.skill} [${item.scenario}] ${item.model} "${item.criterion}": ` +
        `${item.proposed} — ${item.reason}`,
    );
  }
  ctx.out(`Report: ${ctx.show(reportPath)}`);
  return 0;
}

/** True when this module is the script node runs, also through npm's bin link. */
function isEntryPoint(): boolean {
  return Option.from(process.argv[1]).match(
    (script) =>
      Try.run(() => realpathSync(script) === realpathSync(fileURLToPath(import.meta.url)))
        .onFail(false),
    () => false,
  );
}

/**
 * Exits with `code` once the in-flight model calls are killed: they run in their own process
 * group on POSIX, so Ctrl+C does not reach them, and work a config error left queued would keep
 * starting them.
 */
function stop(code: number): void {
  killActiveChildren();
  process.exitCode = code;
  // Let stdout and stderr flush what was written to them first.
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

if (isEntryPoint()) {
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
  void main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
  }).then(stop);
}
