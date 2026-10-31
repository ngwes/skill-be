import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

export interface ProcessOptions {
  bin: string;
  args: string[];
  /** Written to the child's stdin, which is then closed. Prompts go here, never through argv. */
  stdin: string;
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** The exit code; `null` when the child was killed, which includes every timeout. */
  code: number | null;
  timedOut: boolean;
}

/** How long to wait for the streams to close after a timeout kill before giving up on them. */
const KILL_GRACE_MS = 2000;

const isWindows = process.platform === 'win32';

/** The children started by {@link runProcess} that have not closed yet. */
const activeChildren = new Set<ChildProcess>();

/** Set by {@link killActiveChildren}: the process is exiting, so no new child may start. */
let stopping = false;

/**
 * Kills every child {@link runProcess} started that is still running, with every process it
 * started, and returns once they are killed. For the CLI, before it exits on Ctrl+C or on a fatal
 * error: on POSIX each child leads its own process group, so Ctrl+C never reaches it. From then
 * on {@link runProcess} starts no child, so a call still queued behind a limiter cannot leave
 * an orphan running after the exit.
 */
export function killActiveChildren(): void {
  stopping = true;
  for (const child of activeChildren) killTree(child, true);
}

/**
 * Runs `bin` without a shell, writes `stdin` to it and collects its output. On timeout the
 * child and every process it started are killed. Rejects only when the child cannot be started,
 * which includes every call after {@link killActiveChildren}.
 */
export function runProcess(opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (stopping) {
      reject(startError(opts.bin, new Error('skill-be is stopping')));
      return;
    }
    let child: ChildProcess;
    try {
      const command = commandFor(opts);
      child = spawn(command.file, command.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: 'pipe',
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        // On POSIX the child leads its own process group, so a timeout can kill the whole tree.
        detached: !isWindows,
      });
    } catch (error) {
      reject(startError(opts.bin, error));
      return;
    }
    activeChildren.add(child);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: timedOut ? null : code,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // A process that escaped the kill may still hold the pipes open; do not wait for it forever.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, KILL_GRACE_MS);
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('close', (code) => {
      activeChildren.delete(child);
      finish(code);
    });
    child.on('error', (error) => {
      activeChildren.delete(child);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      reject(startError(opts.bin, error));
    });

    // A child that exits without reading its stdin breaks the pipe; its exit code tells the story.
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.stdin, 'utf8');
  });
}

function startError(bin: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`Could not start "${bin}": ${reason}`);
}

/** Kills the child and its descendants; with `wait`, returns only once taskkill is done. */
function killTree(child: ChildProcess, wait = false): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const args = ['/T', '/F', '/PID', String(pid)];
    if (wait) {
      if (spawnSync(taskkill, args, { stdio: 'ignore', windowsHide: true }).error) child.kill();
      return;
    }
    spawn(taskkill, args, { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

interface Command {
  file: string;
  args: string[];
  verbatim: boolean;
}

function commandFor(opts: ProcessOptions): Command {
  return isWindows ? windowsCommand(opts) : { file: opts.bin, args: opts.args, verbatim: false };
}

/**
 * Resolves `bin` on PATH the way cmd.exe does. A `.exe` runs directly. A `.cmd` or `.bat` shim
 * (npm installs these) cannot be spawned without cmd.exe, so it runs through `cmd.exe /d /s /c`
 * with every argument escaped for cmd.exe, never interpreted by it.
 */
function windowsCommand(opts: ProcessOptions): Command {
  const resolved = resolveOnWindows(opts.bin, opts.cwd ?? process.cwd(), opts.env ?? process.env);
  if (resolved === undefined || !/\.(cmd|bat)$/i.test(resolved)) {
    return { file: resolved ?? opts.bin, args: opts.args, verbatim: false };
  }
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${cmdLine(resolved, opts.args)}"`],
    verbatim: true,
  };
}

const WINDOWS_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

function resolveOnWindows(bin: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const names = WINDOWS_EXTENSIONS.includes(path.extname(bin).toLowerCase())
    ? [bin]
    : WINDOWS_EXTENSIONS.map((extension) => bin + extension);
  const hasDirectory = /[\\/]/.test(bin);
  const directories = hasDirectory ? [cwd] : pathDirectories(env);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    }
  }
  return undefined;
}

function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  const value = key === undefined ? '' : (env[key] ?? '');
  return value
    .split(';')
    .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter((directory) => directory !== '');
}

const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function cmdEscape(text: string): string {
  return text.replace(CMD_METACHARACTERS, '^$1');
}

/** Quotes an argument the way the Microsoft C runtime parses it back into argv. */
function quoteArgument(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

function cmdLine(file: string, args: string[]): string {
  for (const arg of args) {
    if (/[\r\n]/.test(arg)) {
      throw new Error(`An argument with a line break cannot be passed to ${file} through cmd.exe`);
    }
    // cmd.exe expands %VAR% and %VAR:x=y% before it strips carets, so no escaping protects a
    // percent sign: it could rewrite the argument or inject a command from the environment.
    if (arg.includes('%')) {
      throw new Error(
        `An argument with a percent sign cannot be passed to ${file} through cmd.exe`,
      );
    }
  }
  // cmd.exe parses the line once to start the shim, and again where the shim expands %*,
  // so each argument is escaped twice.
  const escapedArgs = args.map((arg) => cmdEscape(cmdEscape(quoteArgument(arg))));
  return [cmdEscape(file), ...escapedArgs].join(' ');
}
