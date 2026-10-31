import { Option } from '@ngwes/mini-fp';
import { valueOrThrow } from '../checked.js';
import { runProcess } from '../process.js';
import type { AdapterSettings } from '../types.js';
import {
  apiKeyFromEnv,
  binSetting,
  NO_TOOLS_NOTE,
  requiredSetting,
  runCli,
  type Adapter,
  type Runner,
} from './common.js';

/**
 * `pi -p --provider <provider> --model <id>` without the user's environment (`pi -p` reads the
 * prompt from stdin):
 *   --no-tools, --no-mcp      no tools and no MCP servers: the model answers in text
 *   --no-skills, --no-extensions, --no-prompt-templates, --no-themes
 *                             no discovered or installed resources
 *   --no-context-files        no AGENTS.md or CLAUDE.md
 *   --no-approve              ignore project-local files (.pi/) in the working directory
 *   --no-session              no session file per call
 *   --system-prompt           the no-tools note replaces pi's coding prompt and any SYSTEM.md
 *   --append-system-prompt '' given at all, it stops pi discovering APPEND_SYSTEM.md
 *   --thinking off            unless the `thinking` setting picks a level; pins what
 *                             ~/.pi/agent/settings.json would set (`defaultThinkingLevel`)
 * `provider` is required: pi would otherwise use the default provider in its settings.
 */
export function buildArgs(settings: AdapterSettings): string[] {
  return [
    '-p',
    '--provider',
    requiredSetting(settings, 'provider'),
    '--model',
    settings.id,
    '--thinking',
    thinkingLevel(settings),
    '--system-prompt',
    NO_TOOLS_NOTE,
    '--append-system-prompt',
    '',
    '--no-tools',
    '--no-mcp',
    '--no-skills',
    '--no-extensions',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--no-session',
  ];
}

/** pi's `--thinking` levels (pi 1.4.0). */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function thinkingLevel(settings: AdapterSettings): string {
  const level: unknown = Option.from(settings.thinking).orElse('off');
  return valueOrThrow(
    Option.from(typeof level === 'string' && THINKING_LEVELS.includes(level) ? level : undefined)
      .toEither(
        () =>
          `the pi-cli adapter's "thinking" setting must be one of ${THINKING_LEVELS.join(', ')} ` +
          `(got ${JSON.stringify(level)})`,
      ),
  );
}

/**
 * Without a key from `apiKeyEnv` (see `apiKeyFromEnv`), pi uses its stored login
 * (`~/.pi/agent/auth.json`). With one, the key goes through `--api-key`: pi prefers a stored login
 * over the provider's environment variable, so the flag is the only way to make it use the key.
 * It is visible in the process list while pi runs.
 */
export function createPiCli(run: Runner = runProcess): Adapter {
  return async (prompt, { settings, timeoutMs, cwd }) => {
    const args = buildArgs(settings);
    const key = Option.from(apiKeyFromEnv(settings));
    const result = await runCli(
      run,
      {
        bin: binSetting(settings, 'pi'),
        args: key.match(
          (value) => [...args, '--api-key', value],
          () => args,
        ),
        stdin: prompt,
        timeoutMs,
        cwd,
      },
      { label: `pi-cli (${settings.id})`, secrets: key.match((value) => [value], () => []) },
    );
    return result.stdout.trim();
  };
}

export const piCli: Adapter = createPiCli();
