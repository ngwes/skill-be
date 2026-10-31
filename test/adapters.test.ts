import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdapterError,
  resolveAdapter,
  type AdapterContext,
  type Runner,
} from '../src/adapters/index.js';
import { buildArgs as claudeArgs, createClaudeCli } from '../src/adapters/claude-cli.js';
import { apiKeyFromEnv, isCi } from '../src/adapters/common.js';
import { commandAdapter } from '../src/adapters/command.js';
import { buildArgs as opencodeArgs, createOpencodeCli } from '../src/adapters/opencode-cli.js';
import { buildArgs as piArgs, createPiCli } from '../src/adapters/pi-cli.js';
import type { ProcessOptions, ProcessResult } from '../src/process.js';
import { ConfigError, type AdapterSettings } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NO_TOOLS_NOTE =
  'No tools are available in this session. Answer directly in your reply; do not try to call ' +
  'tools, read files or explore a codebase.';

afterEach(() => {
  vi.unstubAllEnvs();
});

function ctx(settings: AdapterSettings, timeoutMs = 10_000): AdapterContext {
  return { settings, timeoutMs, cwd: ROOT };
}

/** A runner that records each call and answers with `result` (or what `respond` returns). */
function fakeRunner(
  result: Partial<ProcessResult> = {},
  respond?: (opts: ProcessOptions) => Partial<ProcessResult>,
): { run: Runner; calls: ProcessOptions[] } {
  const calls: ProcessOptions[] = [];
  const run: Runner = async (opts) => {
    calls.push(opts);
    return { stdout: '', stderr: '', code: 0, timedOut: false, ...result, ...respond?.(opts) };
  };
  return { run, calls };
}

function failingRunner(): Runner {
  return async () => {
    throw new Error('Could not start "x": spawn x ENOENT');
  };
}

async function adapterError(promise: Promise<unknown>): Promise<AdapterError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AdapterError);
  return error as AdapterError;
}

/** The value right after `flag` in `args`, which must contain `flag` once. */
function flagValue(args: string[], flag: string): string | undefined {
  expect(args.filter((arg) => arg === flag)).toHaveLength(1);
  return args[args.indexOf(flag) + 1];
}

describe('apiKeyFromEnv', () => {
  const keyed: AdapterSettings = { adapter: 'pi-cli', id: 'm', apiKeyEnv: 'X_KEY' };

  it('returns the key when the variable is set, in CI or not', () => {
    vi.stubEnv('X_KEY', 'sk-test');
    vi.stubEnv('CI', 'true');
    expect(apiKeyFromEnv(keyed)).toBe('sk-test');
    vi.stubEnv('CI', undefined);
    expect(apiKeyFromEnv(keyed)).toBe('sk-test');
  });

  it('falls back to the stored login when the variable is unset or empty outside CI', () => {
    vi.stubEnv('CI', undefined);
    vi.stubEnv('X_KEY', undefined);
    expect(apiKeyFromEnv(keyed)).toBeUndefined();
    vi.stubEnv('X_KEY', '');
    expect(apiKeyFromEnv(keyed)).toBeUndefined();
  });

  it('refuses an unset or empty variable in CI, naming it', () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('X_KEY', undefined);
    expect(() => apiKeyFromEnv(keyed)).toThrow(ConfigError);
    expect(() => apiKeyFromEnv(keyed)).toThrow('$X_KEY');
    vi.stubEnv('X_KEY', '');
    expect(() => apiKeyFromEnv(keyed)).toThrow('$X_KEY');
  });

  it('uses the stored login without apiKeyEnv, in CI or not', () => {
    const settings: AdapterSettings = { adapter: 'pi-cli', id: 'm' };
    vi.stubEnv('CI', 'true');
    expect(apiKeyFromEnv(settings)).toBeUndefined();
    vi.stubEnv('CI', undefined);
    expect(apiKeyFromEnv(settings)).toBeUndefined();
  });

  it('treats CI as set for any non-empty value except false and 0', () => {
    for (const value of ['true', '1', 'yes', 'TRUE']) {
      vi.stubEnv('CI', value);
      expect(isCi(), value).toBe(true);
    }
    for (const value of [undefined, '', 'false', 'FALSE', '0']) {
      vi.stubEnv('CI', value);
      expect(isCi(), String(value)).toBe(false);
    }
  });
});

describe('claude-cli', () => {
  const settings: AdapterSettings = { adapter: 'claude-cli', id: 'claude-sonnet-5-5' };

  it('builds the isolated claude -p flags', () => {
    expect(claudeArgs(settings)).toEqual([
      '-p',
      '--model',
      'claude-sonnet-5-5',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--tools',
      '',
      '--append-system-prompt',
      NO_TOOLS_NOTE,
      '--no-session-persistence',
    ]);
  });

  it('writes the prompt to stdin and returns the trimmed answer', async () => {
    const { run, calls } = fakeRunner({ stdout: '\n  the answer \n' });

    const answer = await createClaudeCli(run)('the prompt', ctx(settings, 5000));

    expect(answer).toBe('the answer');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      bin: 'claude',
      args: claudeArgs(settings),
      stdin: 'the prompt',
      timeoutMs: 5000,
    });
  });

  it('runs in a fresh empty directory, not in the project, and removes it after', async () => {
    const seen: { dir: string; entries: string[] }[] = [];
    const record = (opts: ProcessOptions) => {
      seen.push({ dir: opts.cwd!, entries: readdirSync(opts.cwd!) });
      return {};
    };

    await createClaudeCli(fakeRunner({ stdout: 'ok' }, record).run)('p', ctx(settings));
    await adapterError(createClaudeCli(fakeRunner({ code: 1 }, record).run)('p', ctx(settings)));

    expect(seen).toHaveLength(2);
    for (const { dir, entries } of seen) {
      expect(path.relative(ROOT, dir).startsWith('..')).toBe(true);
      expect(entries).toEqual([]);
      expect(statSync(dir, { throwIfNoEntry: false })).toBeUndefined();
    }
    expect(seen[0]!.dir).not.toBe(seen[1]!.dir);
  });

  it('uses its own login when there is no apiKeyEnv', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { run, calls } = fakeRunner({ stdout: 'ok' });

    await createClaudeCli(run)('p', ctx(settings));

    expect(calls[0]!.env?.ANTHROPIC_API_KEY).toBe('');
  });

  it('turns off auto memory, which --setting-sources does not cover, and inherits the rest', async () => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_AUTO_MEMORY', '0');
    vi.stubEnv('SKILL_BE_TEST_INHERITED', 'kept');
    vi.stubEnv('X_KEY', 'sk-test-claude');
    const { run, calls } = fakeRunner({ stdout: 'ok' });

    await createClaudeCli(run)('p', ctx(settings));
    await createClaudeCli(run)('p', ctx({ ...settings, apiKeyEnv: 'X_KEY' }));

    for (const call of calls) {
      expect(call.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
      expect(call.env?.SKILL_BE_TEST_INHERITED).toBe('kept');
    }
  });

  it('passes the apiKeyEnv value as ANTHROPIC_API_KEY', async () => {
    vi.stubEnv('X_KEY', 'sk-test-claude');
    const { run, calls } = fakeRunner({ stdout: 'ok' });

    await createClaudeCli(run)('p', ctx({ ...settings, apiKeyEnv: 'X_KEY' }));

    expect(calls[0]!.env?.ANTHROPIC_API_KEY).toBe('sk-test-claude');
    expect(calls[0]!.args.join(' ')).not.toContain('sk-test-claude');
  });

  it('uses its own login when the apiKeyEnv variable is unset outside CI', async () => {
    vi.stubEnv('CI', undefined);
    vi.stubEnv('X_KEY', undefined);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { run, calls } = fakeRunner({ stdout: 'ok' });

    await createClaudeCli(run)('p', ctx({ ...settings, apiKeyEnv: 'X_KEY' }));

    expect(calls[0]!.env?.ANTHROPIC_API_KEY).toBe('');
  });

  it('refuses an unset apiKeyEnv variable in CI', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('X_KEY', undefined);
    const { run, calls } = fakeRunner();

    const promise = createClaudeCli(run)('p', ctx({ ...settings, apiKeyEnv: 'X_KEY' }));

    await expect(promise).rejects.toThrow(ConfigError);
    await expect(promise).rejects.toThrow(/X_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('starts the binary named by the bin setting', async () => {
    const { run, calls } = fakeRunner({ stdout: 'ok' });

    await createClaudeCli(run)('p', ctx({ ...settings, bin: 'C:/tools/claude.exe' }));

    expect(calls[0]!.bin).toBe('C:/tools/claude.exe');
  });

  it('resolves a relative bin against the config directory, not its temp directory', async () => {
    const { run, calls } = fakeRunner({ stdout: 'ok' });

    await createClaudeCli(run)('p', ctx({ ...settings, bin: './node_modules/.bin/claude' }));
    await createClaudeCli(run)('p', ctx({ ...settings, bin: '../tools/claude' }));

    expect(calls[0]!.bin).toBe(path.resolve(ROOT, 'node_modules/.bin/claude'));
    expect(calls[1]!.bin).toBe(path.resolve(ROOT, '../tools/claude'));
  });

  it('maps a non-zero exit, a timeout and a start failure to AdapterError kinds', async () => {
    const exit = await adapterError(
      createClaudeCli(fakeRunner({ code: 1, stderr: 'model not found' }).run)('p', ctx(settings)),
    );
    expect(exit.kind).toBe('exit');
    expect(exit.message).toContain('model not found');

    const timeout = await adapterError(
      createClaudeCli(fakeRunner({ code: null, timedOut: true }).run)('p', ctx(settings, 1500)),
    );
    expect(timeout.kind).toBe('timeout');
    expect(timeout.message).toContain('1.5s');

    const spawn = await adapterError(createClaudeCli(failingRunner())('p', ctx(settings)));
    expect(spawn.kind).toBe('spawn');
    expect(spawn.message).toContain('ENOENT');
  });
});

describe('pi-cli', () => {
  const settings: AdapterSettings = {
    adapter: 'pi-cli',
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
  };

  it('builds the isolated pi -p flags', () => {
    const args = piArgs(settings);

    expect(args[0]).toBe('-p');
    expect(flagValue(args, '--provider')).toBe('anthropic');
    expect(flagValue(args, '--model')).toBe('claude-sonnet-5-5');
    for (const flag of [
      '--no-tools',
      '--no-skills',
      '--no-extensions',
      '--no-context-files',
      '--no-prompt-templates',
      '--no-themes',
      '--no-session',
    ]) {
      expect(args).toContain(flag);
    }
  });

  it("replaces pi's system prompt and skips SYSTEM.md and APPEND_SYSTEM.md", () => {
    const args = piArgs(settings);

    // --system-prompt wins over a discovered SYSTEM.md; any --append-system-prompt, even an
    // empty one, stops pi from discovering APPEND_SYSTEM.md.
    expect(flagValue(args, '--system-prompt')).toBe(NO_TOOLS_NOTE);
    expect(flagValue(args, '--append-system-prompt')).toBe('');
    for (const arg of args) expect(arg).not.toMatch(/[%\r\n]/);
  });

  it('turns thinking off unless the thinking setting picks a level', () => {
    expect(flagValue(piArgs(settings), '--thinking')).toBe('off');
    expect(flagValue(piArgs({ ...settings, thinking: 'high' }), '--thinking')).toBe('high');
    expect(() => piArgs({ ...settings, thinking: 'turbo' })).toThrow(ConfigError);
    expect(() => piArgs({ ...settings, thinking: 'turbo' })).toThrow(/off, minimal, low/);
    expect(() => piArgs({ ...settings, thinking: 3 })).toThrow(ConfigError);
  });

  it('requires a provider', async () => {
    const withoutProvider = { adapter: 'pi-cli', id: 'claude-sonnet-5-5' };
    expect(() => piArgs(withoutProvider)).toThrow(ConfigError);
    const { run, calls } = fakeRunner();
    await expect(createPiCli(run)('p', ctx(withoutProvider))).rejects.toThrow(ConfigError);
    expect(calls).toHaveLength(0);
  });

  it('writes the prompt to stdin and uses the stored login without apiKeyEnv', async () => {
    const { run, calls } = fakeRunner({ stdout: 'ok\n' });

    const answer = await createPiCli(run)('the prompt', ctx(settings));

    expect(answer).toBe('ok');
    expect(calls[0]).toMatchObject({ bin: 'pi', args: piArgs(settings), stdin: 'the prompt' });
    expect(calls[0]!.args).not.toContain('--api-key');
    expect(calls[0]!.env).toBeUndefined();
  });

  it('passes the apiKeyEnv value with --api-key and keeps it out of error messages', async () => {
    vi.stubEnv('X_KEY', 'sk-test-pi');
    const keyed = { ...settings, apiKeyEnv: 'X_KEY' };
    const { run, calls } = fakeRunner({ code: 1, stderr: 'rejected key sk-test-pi' });

    const error = await adapterError(createPiCli(run)('p', ctx(keyed)));

    expect(flagValue(calls[0]!.args, '--api-key')).toBe('sk-test-pi');
    expect(error.kind).toBe('exit');
    expect(error.message).not.toContain('sk-test-pi');
    expect(error.message).toContain('rejected key');
  });

  it('refuses an apiKeyEnv naming an unset variable in CI', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('X_KEY', undefined);
    const { run, calls } = fakeRunner();

    const promise = createPiCli(run)('p', ctx({ ...settings, apiKeyEnv: 'X_KEY' }));

    await expect(promise).rejects.toThrow(ConfigError);
    await expect(promise).rejects.toThrow(/X_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('uses the stored login when the apiKeyEnv variable is unset or empty outside CI', async () => {
    vi.stubEnv('CI', undefined);
    const { run, calls } = fakeRunner({ stdout: 'ok' });

    vi.stubEnv('X_KEY', undefined);
    await createPiCli(run)('p', ctx({ ...settings, apiKeyEnv: 'X_KEY' }));
    vi.stubEnv('X_KEY', '');
    await createPiCli(run)('p', ctx({ ...settings, apiKeyEnv: 'X_KEY' }));

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.args).toEqual(piArgs(settings));
  });
});

describe('opencode-cli', () => {
  const settings: AdapterSettings = {
    adapter: 'opencode-cli',
    id: 'gemini-2.5-flash',
    provider: 'google',
  };

  const events = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n');
  const text = (value: string) => ({ type: 'text', part: { type: 'text', text: value } });

  it('builds the opencode run flags', () => {
    expect(opencodeArgs(settings)).toEqual([
      'run',
      '-m',
      'google/gemini-2.5-flash',
      '--agent',
      'skill-be',
      '--title',
      'skill-be',
      '--pure',
      '--format',
      'json',
    ]);
    expect(() => opencodeArgs({ adapter: 'opencode-cli', id: 'x' })).toThrow(ConfigError);
  });

  it('runs in a fresh empty directory with a generated no-tools config', async () => {
    vi.stubEnv('OPENCODE_CONFIG', 'C:/user/opencode.json');
    vi.stubEnv('OPENCODE_CONFIG_DIR', 'C:/user/opencode');
    vi.stubEnv('OPENCODE_PERMISSION', '{"*":"allow"}');
    let seen: { dir: string; entries: string[]; configHome: string } | undefined;
    const { run, calls } = fakeRunner({ stdout: events(text('ok')) }, (opts) => {
      const dir = flagValue(opts.args, '--dir')!;
      seen = { dir, entries: readdirSync(dir), configHome: opts.env!.XDG_CONFIG_HOME! };
      return {};
    });

    const answer = await createOpencodeCli(run)('the prompt', ctx(settings));

    expect(answer).toBe('ok');
    const call = calls[0]!;
    expect(call.bin).toBe('opencode');
    expect(call.stdin).toBe('the prompt');
    expect(call.args.slice(0, opencodeArgs(settings).length)).toEqual(opencodeArgs(settings));
    expect(call.cwd).toBe(seen!.dir);
    expect(seen!.entries).toEqual([]);
    expect(seen!.configHome).not.toBe(seen!.dir);
    expect(path.dirname(seen!.configHome)).toBe(path.dirname(seen!.dir));

    const env = call.env!;
    expect(env).toMatchObject({
      OPENCODE_DB: ':memory:',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_PURE: '1',
    });
    // opencode reads ~/.opencode from this home whatever else is set; the temp base has none.
    expect(env.OPENCODE_TEST_HOME).toBe(path.dirname(seen!.dir));
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(env.OPENCODE_PERMISSION).toBeUndefined();
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(config.mcp).toEqual({});
    expect(config.agent['skill-be']).toMatchObject({
      mode: 'primary',
      prompt: NO_TOOLS_NOTE,
      tools: { '*': false },
      permission: { '*': 'deny' },
    });

    expect(statSync(seen!.dir, { throwIfNoEntry: false })).toBeUndefined();
    expect(statSync(path.dirname(seen!.dir), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('joins the text events of the JSON output', async () => {
    const stdout = events(
      { type: 'step_start', part: { type: 'step-start' } },
      text('first'),
      text('second'),
      { type: 'step_finish', part: { type: 'step-finish' } },
    );

    const answer = await createOpencodeCli(fakeRunner({ stdout }).run)('p', ctx(settings));

    expect(answer).toBe('first\nsecond');
  });

  it('reports an error event, or no answer at all, as an exit error', async () => {
    const stdout = events({
      type: 'error',
      error: { name: 'APIError', data: { message: 'invalid x-api-key' } },
    });
    const failed = await adapterError(
      createOpencodeCli(fakeRunner({ stdout, code: 1 }).run)('p', ctx(settings)),
    );
    expect(failed.kind).toBe('exit');
    expect(failed.message).toContain('invalid x-api-key');

    const silent = await adapterError(
      createOpencodeCli(fakeRunner({ stdout: '' }).run)('p', ctx(settings)),
    );
    expect(silent.kind).toBe('exit');
  });

  it('removes its directory when the call fails', async () => {
    let dir = '';
    const { run } = fakeRunner({ code: null, timedOut: true }, (opts) => {
      dir = flagValue(opts.args, '--dir')!;
      return {};
    });

    const error = await adapterError(createOpencodeCli(run)('p', ctx(settings)));

    expect(error.kind).toBe('timeout');
    expect(statSync(dir, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('uses the stored login, a set apiKeyEnv key as its only login, or fails in CI', async () => {
    vi.stubEnv('OPENCODE_AUTH_CONTENT', undefined);
    const stored = fakeRunner({ stdout: events(text('ok')) });
    await createOpencodeCli(stored.run)('p', ctx(settings));
    expect(stored.calls[0]!.env!.OPENCODE_AUTH_CONTENT).toBeUndefined();

    vi.stubEnv('X_KEY', 'sk-test-opencode');
    const keyed = fakeRunner({ stdout: events(text('ok')) });
    await createOpencodeCli(keyed.run)('p', ctx({ ...settings, apiKeyEnv: 'X_KEY' }));
    const auth = JSON.parse(keyed.calls[0]!.env!.OPENCODE_AUTH_CONTENT!);
    expect(auth).toEqual({ google: { type: 'api', key: 'sk-test-opencode' } });
    expect(keyed.calls[0]!.args.join(' ')).not.toContain('sk-test-opencode');

    vi.stubEnv('X_KEY', undefined);
    vi.stubEnv('CI', 'true');
    const unset = fakeRunner();
    await expect(
      createOpencodeCli(unset.run)('p', ctx({ ...settings, apiKeyEnv: 'X_KEY' })),
    ).rejects.toThrow(ConfigError);
    expect(unset.calls).toHaveLength(0);

    vi.stubEnv('CI', undefined);
    const local = fakeRunner({ stdout: events(text('ok')) });
    await createOpencodeCli(local.run)('p', ctx({ ...settings, apiKeyEnv: 'X_KEY' }));
    expect(local.calls[0]!.env!.OPENCODE_AUTH_CONTENT).toBeUndefined();
  });
});

describe('command', () => {
  const command = (run: string): AdapterSettings => ({ adapter: 'command', id: 'echo', run });
  const echo = command('node test/fixtures/bin/echo-stdin.mjs');

  function bigPrompt(): string {
    let text = '';
    for (let i = 0; text.length < 100 * 1024; i++) {
      text += `line ${i}: héllo wörld 日本 "quoted" & | %PATH%\n`;
    }
    return text.trim();
  }

  it('returns what the command prints for the prompt on stdin', async () => {
    expect(await commandAdapter('hello prompt', ctx(echo))).toBe('hello prompt');
  });

  it('round-trips a 100 KB prompt', async () => {
    const prompt = bigPrompt();

    const answer = await commandAdapter(prompt, ctx(echo));

    expect(answer.length).toBe(prompt.length);
    expect(answer === prompt).toBe(true);
  });

  it('splits the command line without a shell, keeping quoted words whole', async () => {
    const settings = command(`node "test/fixtures/bin/print-args.mjs" "a b" 'c d' e`);

    const report = JSON.parse(await commandAdapter('p', ctx(settings)));

    expect(report.argv).toEqual(['a b', 'c d', 'e']);
    expect(report.stdin).toBe('p');
  });

  it('reports a non-zero exit as kind exit', async () => {
    const error = await adapterError(
      commandAdapter('p', ctx(command('node test/fixtures/bin/exit-3.mjs'))),
    );
    expect(error.kind).toBe('exit');
    expect(error.message).toContain('exit-3 failed on purpose');
  });

  it('reports a command that never exits as kind timeout', { timeout: 10_000 }, async () => {
    const error = await adapterError(
      commandAdapter('p', ctx(command('node test/fixtures/bin/sleep-forever.mjs'), 500)),
    );
    expect(error.kind).toBe('timeout');
  });

  it('reports a command that cannot start as kind spawn', async () => {
    const error = await adapterError(commandAdapter('p', ctx(command('skill-be-no-such-binary'))));
    expect(error.kind).toBe('spawn');
  });

  it('requires a run setting', async () => {
    await expect(commandAdapter('p', ctx({ adapter: 'command', id: 'x' }))).rejects.toThrow(
      ConfigError,
    );
    await expect(commandAdapter('p', ctx(command(`  ""  `)))).rejects.toThrow(ConfigError);
  });
});

describe('resolveAdapter', () => {
  it('returns the built-in adapters by name', async () => {
    for (const name of ['claude-cli', 'pi-cli', 'opencode-cli', 'command']) {
      expect(typeof (await resolveAdapter(name, ROOT))).toBe('function');
    }
    expect(await resolveAdapter('command', ROOT)).toBe(commandAdapter);
  });

  it('loads a custom module, resolving its path against the config root', async () => {
    const settings: AdapterSettings = { adapter: './custom-adapter.mjs', id: 'mine' };

    const fromRoot = await resolveAdapter('./test/fixtures/custom-adapter.mjs', ROOT);
    const fixtures = path.join(ROOT, 'test/fixtures');
    const fromFixtures = await resolveAdapter('./custom-adapter.mjs', fixtures);

    expect(await fromRoot('hi', ctx(settings))).toBe('custom mine: hi');
    expect(await fromFixtures('hi', ctx(settings))).toBe('custom mine: hi');
  });

  it('refuses an unknown name, a missing file and a module without a default export', async () => {
    await expect(resolveAdapter('codex-cli', ROOT)).rejects.toThrow(ConfigError);
    await expect(resolveAdapter('codex-cli', ROOT)).rejects.toThrow(/claude-cli/);
    await expect(resolveAdapter('./test/fixtures/missing.mjs', ROOT)).rejects.toThrow(ConfigError);
    await expect(resolveAdapter('./test/fixtures/not-an-adapter.mjs', ROOT)).rejects.toThrow(
      ConfigError,
    );
  });
});
