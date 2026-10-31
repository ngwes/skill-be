import { Option } from '@ngwes/mini-fp';
import { valueOrThrow } from '../checked.js';
import { runProcess } from '../process.js';
import { ConfigError } from '../types.js';
import { requiredSetting, runCli, type Adapter } from './common.js';

/**
 * The `command` adapter: runs the `run` setting, writes the prompt to its stdin and returns its
 * stdout. The command line is split into words and started without a shell, so pipes, redirects
 * and variables are not interpreted; quote a word with spaces in "double" or 'single' quotes.
 * It runs in the context's working directory (the config file's directory).
 */
export const commandAdapter: Adapter = async (prompt, { settings, timeoutMs, cwd }) => {
  const run = requiredSetting(settings, 'run');
  const [first, ...args] = splitCommandLine(run, `the command adapter's "run" setting`);
  const bin = valueOrThrow(
    Option.from(first)
      .filter((word) => word !== '')
      .toEither(() => `the command adapter's "run" setting has no command: ${run}`),
  );
  const result = await runCli(
    runProcess,
    { bin, args, stdin: prompt, timeoutMs, cwd },
    { label: `command (${bin})` },
  );
  return result.stdout.trim();
};

/**
 * Splits on whitespace outside quotes; quotes group a word and are removed. `setting` names where
 * the line comes from in the error about an unclosed quote.
 */
export function splitCommandLine(line: string, setting: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= '';
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (quote !== undefined) {
    throw new ConfigError(`${setting} has an unclosed quote: ${line}`);
  }
  if (word !== undefined) words.push(word);
  return words;
}
