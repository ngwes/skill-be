import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../process.js';
import type { AdapterSettings } from '../types.js';
import {
  apiKeyFromEnv,
  binSetting,
  NO_TOOLS_NOTE,
  runCli,
  type Adapter,
  type Runner,
} from './common.js';

/**
 * `claude -p --model <id>` without the user's environment (the prompt goes on stdin):
 *   --setting-sources ''      no user/project/local settings (plugins, hooks, effort, permissions)
 *   --strict-mcp-config       no MCP servers, claude.ai connectors included (no --mcp-config)
 *   --disable-slash-commands  no skills or slash commands in the system prompt
 *   --tools ''                no tools: the model answers in text and cannot touch files
 *   --append-system-prompt    says so; without it the model writes fake tool calls as text
 *   --no-session-persistence  no session transcript per call
 * Auto memory (`~/.claude/projects/<project>/memory/`) loads whatever the setting sources say, so
 * the child also gets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (see `createClaudeCli`). And each call runs
 * in a fresh empty temp directory: in a git repository, claude puts the branch and the recent commit
 * messages in the system prompt.
 */
export function buildArgs(settings: AdapterSettings): string[] {
  return [
    '-p',
    '--model',
    settings.id,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools',
    '',
    '--append-system-prompt',
    NO_TOOLS_NOTE,
    '--no-session-persistence',
  ];
}

/**
 * The working directory is a fresh empty temp directory, removed after the call, so a `bin` such as
 * `./node_modules/.bin/claude` is resolved against the config's directory first. The environment is
 * inherited, with auto memory turned off. Without a key from `apiKeyEnv` (see
 * `apiKeyFromEnv`), claude uses its own login. With one, the key goes to the child as
 * `ANTHROPIC_API_KEY`, which claude prefers over its login.
 */
export function createClaudeCli(run: Runner = runProcess): Adapter {
  return async (prompt, { settings, timeoutMs, cwd }) => {
    const bin = binSetting(settings, 'claude');
    const args = buildArgs(settings);
    const key = apiKeyFromEnv(settings);
    const work = await mkdtemp(path.join(os.tmpdir(), 'skill-be-claude-'));
    try {
      const result = await runCli(
        run,
        {
          bin: /^\.\.?[\\/]/.test(bin) ? path.resolve(cwd, bin) : bin,
          args,
          stdin: prompt,
          timeoutMs,
          cwd: work,
          env: {
            ...process.env,
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            ...(key === undefined ? {} : { ANTHROPIC_API_KEY: key }),
          },
        },
        { label: `claude-cli (${settings.id})`, secrets: key === undefined ? [] : [key] },
      );
      return result.stdout.trim();
    } finally {
      // Best effort: a file a killed child still holds must not turn an answer into an error.
      await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      );
    }
  };
}

export const claudeCli: Adapter = createClaudeCli();
