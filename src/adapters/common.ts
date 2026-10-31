import { Either, Option, TryAsync } from '@ngwes/mini-fp';
import { valueOrThrow } from '../checked.js';
import type { ProcessOptions, ProcessResult } from '../process.js';
import { ConfigError, type AdapterSettings } from '../types.js';

export type AdapterContext = { settings: AdapterSettings; timeoutMs: number; cwd: string };

/** Turns a prompt into the model's text answer. */
export type Adapter = (prompt: string, ctx: AdapterContext) => Promise<string>;

/** Starts a child process; `runProcess` in production, a fake in tests. */
export type Runner = (opts: ProcessOptions) => Promise<ProcessResult>;

/** A model call that failed: it timed out, exited with an error, or could not start. */
export class AdapterError extends Error {
  override name = 'AdapterError';

  constructor(
    message: string,
    readonly kind: 'timeout' | 'exit' | 'spawn',
  ) {
    super(message);
  }
}

/**
 * True for a failure that says nothing about the skill and that the user must fix: a
 * `ConfigError`, or a CLI that could not start (not installed, a wrong `bin`, an argument cmd.exe
 * cannot carry). It stops a run or triage (exit code 2) instead of counting as an output error.
 */
export function isConfigProblem(error: unknown): boolean {
  return error instanceof ConfigError || (error instanceof AdapterError && error.kind === 'spawn');
}

/**
 * The tool-free note appended to the system prompt. Without it the model writes fake tool calls
 * as text.
 */
export const NO_TOOLS_NOTE =
  'No tools are available in this session. Answer directly in your reply; ' +
  'do not try to call tools, read files or explore a codebase.';

/** A setting that must be a non-empty string. */
export function requiredSetting(settings: AdapterSettings, key: string): string {
  const value = settings[key];
  return valueOrThrow(
    Option.from(typeof value === 'string' && value.trim() !== '' ? value : undefined).toEither(
      () => `the ${settings.adapter} adapter needs a non-empty "${key}" setting`,
    ),
  );
}

/** The `bin` setting, or the CLI's usual name. */
export function binSetting(settings: AdapterSettings, fallback: string): string {
  return settings.bin === undefined ? fallback : requiredSetting(settings, 'bin');
}

/** True when the `CI` environment variable is set to anything but empty, `false` or `0`. */
export function isCi(): boolean {
  return Option.from(process.env.CI)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '' && value !== 'false' && value !== '0')
    .isSome();
}

/**
 * The API key named by the `apiKeyEnv` setting, or `undefined` when the CLI should use its own
 * stored login: without `apiKeyEnv`, or with it when its variable is unset or empty outside CI.
 * In CI an unset or empty variable is a `ConfigError`, so a missing secret fails loudly. The
 * key's value never appears in an error.
 */
export function apiKeyFromEnv(settings: AdapterSettings): string | undefined {
  if (settings.apiKeyEnv === undefined) return undefined;
  const name = requiredSetting(settings, 'apiKeyEnv');
  return Option.from(process.env[name], (value) => value === '').match<string | undefined>(
    (key) => key,
    () => {
      if (!isCi()) return undefined;
      throw new ConfigError(
        `the ${settings.adapter} adapter reads its API key from $${name}, which is not set ` +
          '(CI is set, so it does not fall back to the stored login)',
      );
    },
  );
}

export type CliOptions = {
  /** Names the CLI and model in error messages. */
  label: string;
  /** Replaced by `***` wherever they would appear in an error message. */
  secrets?: string[];
  /** Why a failed call failed; by default the end of stderr, else of stdout. */
  failure?: (result: ProcessResult) => string;
};

/**
 * Runs a CLI and returns its result when it exits with code 0. Anything else becomes an
 * `AdapterError` whose message names the CLI and says why, with every secret redacted.
 */
export async function runCli(
  run: Runner,
  opts: ProcessOptions,
  { label, secrets = [], failure = (result) => result.stderr.trim() || result.stdout }: CliOptions,
): Promise<ProcessResult> {
  const redact = (text: string): string => redactSecrets(text, secrets);
  const result = await TryAsync.runAsync(() => run(opts)).onFail((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AdapterError(redact(`${label} could not start: ${reason}`), 'spawn');
  });
  const exitError = (finished: ProcessResult): AdapterError => {
    // Redact before shortening, so no cut can leave part of a secret behind.
    const detail = tail(redact(failure(finished)));
    return new AdapterError(
      `${label} exited with code ${finished.code}${detail ? `: ${detail}` : ''}`,
      'exit',
    );
  };
  return Either.right<AdapterError, ProcessResult>(result)
    .guardBind<ProcessResult>(
      (finished) => Either.right<AdapterError, ProcessResult>(finished),
      [
        (finished) => finished.timedOut,
        () =>
          Either.left(
            new AdapterError(`${label} timed out after ${opts.timeoutMs / 1000}s`, 'timeout'),
          ),
      ],
      [(finished) => finished.code !== 0, (finished) => Either.left(exitError(finished))],
    )
    .match(
      (finished) => finished,
      (error) => {
        throw error;
      },
    );
}

/** `text` with every occurrence of every secret replaced by `***`. */
export function redactSecrets(text: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => result.split(secret).join('***'), text);
}

const DETAIL_LENGTH = 500;

/** The end of a child's output on one line, short enough for an error message. */
function tail(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > DETAIL_LENGTH ? `…${line.slice(-DETAIL_LENGTH)}` : line;
}
