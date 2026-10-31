import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLimiter } from '../src/limiter.js';
import { runProcess, type ProcessOptions } from '../src/process.js';

const BIN = fileURLToPath(new URL('./fixtures/bin/', import.meta.url));
const script = (name: string) => path.join(BIN, name);
const node = process.execPath;
// Room for the kill, the stream grace period and the liveness polling to fail on an assertion.
const KILL_TEST = { timeout: 10_000 };

// Pids printed by fixtures, killed after each test in case an assertion failed first.
let started: number[] = [];

afterEach(() => {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  started = [];
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntilDead(pid: number, withinMs = 2000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

function printedPids(stdout: string): number[] {
  const pids = stdout
    .split(/\r?\n/)
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
  started.push(...pids);
  return pids;
}

function bigInput(): string {
  let text = '';
  for (let i = 0; text.length < 100 * 1024; i++) {
    text += `line ${i}: héllo wörld 日本 "quoted" & | %PATH%\n`;
  }
  return text;
}

describe('runProcess', () => {
  it('returns stdin as stdout with code 0', async () => {
    const result = await runProcess({
      bin: node,
      args: [script('echo-stdin.mjs')],
      stdin: 'hello from stdin\n',
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ stdout: 'hello from stdin\n', stderr: '', code: 0, timedOut: false });
  });

  it('round-trips a 100 KB stdin intact', async () => {
    const input = bigInput();

    const result = await runProcess({
      bin: node,
      args: [script('echo-stdin.mjs')],
      stdin: input,
      timeoutMs: 10_000,
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(input.length);
    expect(result.stdout === input).toBe(true);
  });

  it('reports exit code 3 and stderr, even when the child never reads stdin', async () => {
    const result = await runProcess({
      bin: node,
      args: [script('exit-3.mjs')],
      stdin: bigInput(),
      timeoutMs: 10_000,
    });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain('exit-3 failed on purpose');
    expect(result.timedOut).toBe(false);
  });

  it('kills a child that never exits and reports timedOut', KILL_TEST, async () => {
    const startedAt = Date.now();

    const result = await runProcess({
      bin: node,
      args: [script('sleep-forever.mjs')],
      stdin: '',
      timeoutMs: 500,
    });

    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    const [pid] = printedPids(result.stdout);
    expect(pid).toBeDefined();
    expect(await waitUntilDead(pid!)).toBe(true);
  });

  it('kills the whole process tree on timeout', KILL_TEST, async () => {
    const result = await runProcess({
      bin: node,
      args: [script('spawn-tree.mjs')],
      stdin: '',
      timeoutMs: 1000,
    });

    expect(result.timedOut).toBe(true);
    const pids = printedPids(result.stdout);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(await waitUntilDead(pid)).toBe(true);
  });

  it('passes the arguments, working directory and environment to the child', async () => {
    const cwd = await realpath(os.tmpdir());

    const result = await runProcess({
      bin: node,
      args: [script('print-args.mjs'), '--model', 'a b', ''],
      stdin: 'prompt',
      timeoutMs: 10_000,
      cwd,
      env: { ...process.env, SKILL_BE_TEST_VAR: 'from-env' },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['--model', 'a b', ''],
      stdin: 'prompt',
      cwd,
      envVar: 'from-env',
    });
  });

  it('rejects when the binary cannot be started', async () => {
    await expect(
      runProcess({ bin: 'skill-be-no-such-binary', args: [], stdin: '', timeoutMs: 10_000 }),
    ).rejects.toThrow(/skill-be-no-such-binary/);
  });
});

describe('killActiveChildren', () => {
  // Once it has run, runProcess refuses new children for the life of the module: each test gets
  // a fresh copy, so the tests after these still can start children.
  const fresh = async (): Promise<typeof import('../src/process.js')> => {
    vi.resetModules();
    return import('../src/process.js');
  };
  let markerDir: string | undefined;

  afterEach(async () => {
    if (markerDir) await rm(markerDir, { recursive: true, force: true });
    markerDir = undefined;
  });

  /** A child that writes `marker` as soon as it starts, so a test can tell whether it did. */
  async function markerChild(): Promise<{ opts: ProcessOptions; marker: string }> {
    markerDir = await mkdtemp(path.join(os.tmpdir(), 'skill-be-stop-'));
    const marker = path.join(markerDir, 'started');
    const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
    return { opts: { bin: node, args: ['-e', code], stdin: '', timeoutMs: 10_000 }, marker };
  }

  it('kills every running child with the processes it started', KILL_TEST, async () => {
    const { killActiveChildren, runProcess } = await fresh();
    const running = runProcess({
      bin: node,
      args: [script('spawn-tree.mjs')],
      stdin: '',
      timeoutMs: 60_000,
    });
    // Time for the child to start its grandchild and print both pids.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    killActiveChildren();
    const result = await running;

    expect(result.timedOut).toBe(false);
    const pids = printedPids(result.stdout);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(await waitUntilDead(pid)).toBe(true);
  });

  it('does nothing when no child is running', async () => {
    const { killActiveChildren } = await fresh();

    expect(() => killActiveChildren()).not.toThrow();
  });

  it('makes runProcess refuse to start a child afterwards', async () => {
    const { killActiveChildren, runProcess } = await fresh();
    const { opts, marker } = await markerChild();

    killActiveChildren();

    await expect(runProcess(opts)).rejects.toThrow(/stopping/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps a call still queued behind the limiter from starting a child', KILL_TEST, async () => {
    const { killActiveChildren, runProcess } = await fresh();
    const { opts, marker } = await markerChild();
    const limit = createLimiter(1);
    const running = limit(() =>
      runProcess({ bin: node, args: [script('sleep-forever.mjs')], stdin: '', timeoutMs: 60_000 }),
    );
    const queued = limit(() => runProcess(opts));
    queued.catch(() => {});
    // Time for the first child to start.
    await new Promise((resolve) => setTimeout(resolve, 500));

    killActiveChildren();

    printedPids((await running).stdout);
    await expect(queued).rejects.toThrow(/stopping/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(marker)).toBe(false);
  });
});

// npm and other tools install `.cmd` shims on Windows, which Node refuses to spawn without cmd.exe.
describe.runIf(process.platform === 'win32')('runProcess with a Windows .cmd shim', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // A shim shaped like npm's: it forwards %* to node, so cmd.exe parses the arguments twice.
  async function makeShim(name: string, target: string): Promise<NodeJS.ProcessEnv> {
    dir = await mkdtemp(path.join(os.tmpdir(), 'skill-be shim & (x)-'));
    await writeFile(
      path.join(dir, `${name}.cmd`),
      `@ECHO off\r\nSETLOCAL\r\n"${node}" "${script(target)}" %*\r\n`,
    );
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = `${dir}${path.delimiter}${env[pathKey] ?? ''}`;
    return env;
  }

  it('finds the shim on PATH by its bare name and passes hostile arguments intact', async () => {
    const env = await makeShim('skill-be-shim', 'print-args.mjs');
    const args = [
      '',
      'a b',
      'q"uote',
      'say "hi" & echo injected',
      '"&echo injected&"',
      'a"|b"<c',
      'trail\\',
      'back\\"q',
      '&',
      'a|b',
      '^caret',
      '<in>',
      '!bang!',
      '(paren)',
      'x,y;z',
      '*?',
      '`tick`',
      'No tools are available in this session. Answer directly; do not call tools.',
      'C:\\dir with space\\',
      'é ünï 日本',
    ];

    const stdin = 'a & b | "c"';

    const result = await runProcess({ bin: 'skill-be-shim', args, stdin, timeoutMs: 10_000, env });

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    expect(report.argv).toEqual(args);
    expect(report.stdin).toBe(stdin);
  });

  it('kills the process behind the shim on timeout', KILL_TEST, async () => {
    const env = await makeShim('skill-be-sleeper', 'sleep-forever.mjs');

    const result = await runProcess({
      bin: 'skill-be-sleeper',
      args: [],
      stdin: '',
      timeoutMs: 1000,
      env,
    });

    expect(result.timedOut).toBe(true);
    const [pid] = printedPids(result.stdout);
    expect(pid).toBeDefined();
    expect(await waitUntilDead(pid!)).toBe(true);
  });

  it('rejects an argument with a line break, which cmd.exe cannot pass', async () => {
    const env = await makeShim('skill-be-shim', 'print-args.mjs');

    await expect(
      runProcess({ bin: 'skill-be-shim', args: ['two\nlines'], stdin: '', timeoutMs: 10_000, env }),
    ).rejects.toThrow(/line break/);
  });

  // cmd.exe expands %VAR% and %VAR:x=y% before it strips carets,
  // so a percent sign cannot be escaped.
  it.each(['%PATH%', '%OS%', '%OS:W=X%', '%OS:*W=Z%', '100%'])(
    'rejects an argument with a percent sign, which cmd.exe would expand: %s',
    async (arg) => {
      const env = await makeShim('skill-be-shim', 'print-args.mjs');

      await expect(
        runProcess({ bin: 'skill-be-shim', args: [arg], stdin: '', timeoutMs: 10_000, env }),
      ).rejects.toThrow(/percent sign/);
    },
  );

  it('does not run a command smuggled in through a %VAR:x=y% substitution', async () => {
    const env = await makeShim('skill-be-shim', 'print-args.mjs');
    const injected = path.join(dir!, 'INJECTED.txt');
    env.SKB_X = `a&echo pwned>"${injected}"&`;

    await expect(
      runProcess({
        bin: 'skill-be-shim',
        args: ['%SKB_X:Q=Q%'],
        stdin: '',
        timeoutMs: 10_000,
        env,
      }),
    ).rejects.toThrow(/percent sign/);
    expect(existsSync(injected)).toBe(false);
  });
});
