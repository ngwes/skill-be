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
 * the child also gets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (see `createClaudeCli`).
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
 * The environment is inherited, with auto memory turned off. Without a key from `apiKeyEnv` (see
 * `apiKeyFromEnv`), claude uses its own login. With one, the key goes to the child as
 * `ANTHROPIC_API_KEY`, which claude prefers over its login.
 */
export function createClaudeCli(run: Runner = runProcess): Adapter {
  return async (prompt, { settings, timeoutMs, cwd }) => {
    const args = buildArgs(settings);
    const key = apiKeyFromEnv(settings);
    const result = await runCli(
      run,
      {
        bin: binSetting(settings, 'claude'),
        args,
        stdin: prompt,
        timeoutMs,
        cwd,
        env: {
          ...process.env,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          ...(key === undefined ? {} : { ANTHROPIC_API_KEY: key }),
        },
      },
      { label: `claude-cli (${settings.id})`, secrets: key === undefined ? [] : [key] },
    );
    return result.stdout.trim();
  };
}

export const claudeCli: Adapter = createClaudeCli();
