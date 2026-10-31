/**
 * The `opencode-cli` adapter: `opencode run -m <provider>/<id>` with the prompt on stdin
 * (`opencode run` appends a piped stdin to the message), read back from `--format json` events.
 *
 * `opencode run` has no flags that turn off tools, settings or context files. Checked against
 * opencode 1.19.5, each call gets this isolation instead:
 * - A fresh empty temp directory, given with `--dir` and as the working directory, so there is no
 *   project to read, and `OPENCODE_DISABLE_PROJECT_CONFIG=1`: no project `opencode.json`,
 *   `.opencode/` or `AGENTS.md`.
 * - `XDG_CONFIG_HOME` points at a second empty temp directory: the user's global config
 *   (`~/.config/opencode`, with its MCP servers, plugins, agents and `AGENTS.md`) is not loaded.
 * - `OPENCODE_TEST_HOME` points at the temp base, which has no `.opencode`. opencode always reads
 *   `<home>/.opencode` (its `opencode.json`, agents, commands and plugins), even with
 *   `OPENCODE_DISABLE_PROJECT_CONFIG`, and takes `<home>` from this variable before
 *   `os.homedir()`. The stored login is unaffected: the data directory holding `auth.json` comes
 *   from `XDG_DATA_HOME` or `os.homedir()`, not from this variable. The variable is meant for
 *   opencode's own tests, so a later opencode may drop it.
 * - `OPENCODE_CONFIG_CONTENT` holds a generated config whose `skillbe` agent (`--agent skillbe`)
 *   has every tool off and every permission denied, and the no-tools note as its whole system
 *   prompt, in place of opencode's coding prompt. No tool definitions reach the model: the
 *   request for "Reply with exactly: ok" is about 200 input tokens. Inherited `OPENCODE_CONFIG`,
 *   `OPENCODE_CONFIG_DIR` and `OPENCODE_PERMISSION` are removed so they cannot merge back in.
 * - `--pure` and `OPENCODE_PURE=1`: no external plugins. `OPENCODE_DISABLE_CLAUDE_CODE=1`: no
 *   `~/.claude/CLAUDE.md` or `~/.claude/skills`. `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`: no other
 *   skill folders. `OPENCODE_DISABLE_AUTOUPDATE=1`: no self-update.
 * - `OPENCODE_DB=:memory:`: the session lives in memory, so no transcript is written to the
 *   user's `opencode.db`. `--title skillbe` skips the extra model call that names the session.
 *
 * What it could not get:
 * - opencode still writes its log (`~/.local/share/opencode/log/opencode.log`): run metadata
 *   such as the session id, model and temp directory, not the prompt or the answer.
 * - The system prompt still carries opencode's environment block (working directory, platform,
 *   date), and opencode's built-in plugins still load (`--pure` only drops external ones).
 * - opencode may still fetch its model catalog from models.dev at startup.
 *
 * Credentials: without a key from `apiKeyEnv` (see `apiKeyFromEnv`), opencode uses its stored
 * login (`opencode auth list`). With one, the key goes in `OPENCODE_AUTH_CONTENT`, which replaces
 * the stored logins for that call: a provider environment variable such as `ANTHROPIC_API_KEY` is
 * ignored when a login is stored.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../process.js';
import type { AdapterSettings } from '../types.js';
import {
  AdapterError,
  apiKeyFromEnv,
  binSetting,
  NO_TOOLS_NOTE,
  redactSecrets,
  requiredSetting,
  runCli,
  type Adapter,
  type Runner,
} from './common.js';

const AGENT = 'skillbe';

const CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  share: 'disabled',
  snapshot: false,
  lsp: false,
  formatter: false,
  mcp: {},
  plugin: [],
  instructions: [],
  permission: { '*': 'deny' },
  agent: {
    [AGENT]: {
      mode: 'primary',
      prompt: NO_TOOLS_NOTE,
      tools: { '*': false },
      permission: { '*': 'deny' },
    },
  },
};

const ISOLATION_ENV = {
  OPENCODE_CONFIG_CONTENT: JSON.stringify(CONFIG),
  OPENCODE_DB: ':memory:',
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_PURE: '1',
};

/** Variables that would merge the user's own config back in. */
const INHERITED_CONFIG_VARS = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_PERMISSION'];

/** The flags of every call; `--dir <temp dir>` is added per call. */
export function buildArgs(settings: AdapterSettings): string[] {
  const provider = requiredSetting(settings, 'provider');
  return [
    'run',
    '-m',
    `${provider}/${settings.id}`,
    '--agent',
    AGENT,
    '--title',
    AGENT,
    '--pure',
    '--format',
    'json',
  ];
}

export function createOpencodeCli(run: Runner = runProcess): Adapter {
  return async (prompt, { settings, timeoutMs }) => {
    const args = buildArgs(settings);
    const provider = requiredSetting(settings, 'provider');
    const key = apiKeyFromEnv(settings);
    const label = `opencode-cli (${provider}/${settings.id})`;

    const base = await mkdtemp(path.join(os.tmpdir(), 'skillbe-opencode-'));
    try {
      const work = path.join(base, 'work');
      const configHome = path.join(base, 'config');
      await Promise.all([mkdir(work), mkdir(configHome)]);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...ISOLATION_ENV,
        XDG_CONFIG_HOME: configHome,
        OPENCODE_TEST_HOME: base,
      };
      for (const name of INHERITED_CONFIG_VARS) delete env[name];
      if (key !== undefined) {
        env.OPENCODE_AUTH_CONTENT = JSON.stringify({ [provider]: { type: 'api', key } });
      }

      const secrets = key === undefined ? [] : [key];
      const result = await runCli(
        run,
        {
          bin: binSetting(settings, 'opencode'),
          args: [...args, '--dir', work],
          stdin: prompt,
          timeoutMs,
          cwd: work,
          env,
        },
        {
          label,
          secrets,
          failure: (failed) => errorMessage(events(failed.stdout)) ?? failed.stderr,
        },
      );

      const answer = events(result.stdout);
      const error = errorMessage(answer);
      if (error !== undefined) {
        throw new AdapterError(`${label} failed: ${redactSecrets(error, secrets)}`, 'exit');
      }
      const texts = answer.flatMap((event) =>
        event.type === 'text' && typeof event.part?.text === 'string' ? [event.part.text] : [],
      );
      if (texts.length === 0) throw new AdapterError(`${label} returned no answer`, 'exit');
      return texts.join('\n').trim();
    } finally {
      // Best effort: a file a killed child still holds must not turn an answer into an error.
      await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      );
    }
  };
}

type OpencodeEvent = {
  type?: unknown;
  part?: { text?: unknown };
  error?: { name?: unknown; data?: { message?: unknown } };
};

/** The events of `--format json` output, one JSON object per line; other lines are skipped. */
function events(stdout: string): OpencodeEvent[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    if (!line.trimStart().startsWith('{')) return [];
    try {
      const event: unknown = JSON.parse(line);
      return typeof event === 'object' && event !== null ? [event as OpencodeEvent] : [];
    } catch {
      return [];
    }
  });
}

/** The message of the first error event, if any. */
function errorMessage(stream: OpencodeEvent[]): string | undefined {
  const error = stream.find((event) => event.type === 'error')?.error;
  if (error === undefined) return undefined;
  return String(error.data?.message ?? error.name ?? 'unknown error');
}

export const opencodeCli: Adapter = createOpencodeCli();
