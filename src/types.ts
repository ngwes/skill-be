/** A `model`, `grader` or `triage.model` entry: adapter, model id and its own settings. */
export type AdapterSettings = { adapter: string; id: string; [key: string]: unknown };

export type TypecheckConfig = {
  preset?: 'typescript';
  command?: string;
  library?: string;
  blocking: boolean;
  preludes?: Record<string, string>;
};

export type CoverageConfig = {
  preset?: 'typescript';
  command?: string;
  entry?: string;
  ignore: string[];
  blocking: boolean;
};

export type Config = {
  /** The directory of the config file. */
  root: string;
  /** Absolute path of the config file; the fingerprint of every skill covers it. */
  configPath: string;
  /** Absolute path of the skills directory. */
  skills: string;
  /** Absolute path of the evals directory. */
  evals: string;
  models: AdapterSettings[];
  grader: AdapterSettings;
  reps: number;
  gradings: number;
  concurrency: number;
  timeoutSeconds: number;
  /** Absolute path of the results directory. */
  results: string;
  /** Absolute path of the committed result file. */
  resultFile: string;
  withSkillTemplate: string;
  graderPrompt: string | null;
  gate: { regressionOnCritical: boolean; blockOnZero: boolean; blockOnErrors: boolean };
  checks: { typecheck: TypecheckConfig | false; coverage: CoverageConfig | false };
  triage: { model: AdapterSettings | null };
};

export type Scenario = { id: string; critical: boolean; prompt: string; criteria: string[] };

export type SkillSuite = {
  name: string;
  /** Absolute path of the skill's `SKILL.md` file. */
  skillPath: string;
  skillText: string;
  /** Absolute path of the skill's eval file. */
  evalPath: string;
  scenarios: Scenario[];
};

/** A problem with the config, the skills or an eval file: the user must fix it (exit code 2). */
export class ConfigError extends Error {
  override name = 'ConfigError';
}
