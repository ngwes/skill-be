import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from '../types.js';
import { claudeCli } from './claude-cli.js';
import { commandAdapter } from './command.js';
import type { Adapter } from './common.js';
import { opencodeCli } from './opencode-cli.js';
import { piCli } from './pi-cli.js';

export {
  AdapterError,
  isConfigProblem,
  type Adapter,
  type AdapterContext,
  type Runner,
} from './common.js';

const BUILT_IN: Record<string, Adapter> = {
  'claude-cli': claudeCli,
  'pi-cli': piCli,
  'opencode-cli': opencodeCli,
  command: commandAdapter,
};

/**
 * A built-in adapter by name, or the default export of the module at a path (`./my-adapter.js`),
 * resolved against the config file's directory.
 */
export async function resolveAdapter(name: string, configRoot: string): Promise<Adapter> {
  const builtIn = Object.prototype.hasOwnProperty.call(BUILT_IN, name) ? BUILT_IN[name] : undefined;
  if (builtIn !== undefined) return builtIn;
  if (!looksLikePath(name)) {
    throw new ConfigError(
      `unknown adapter "${name}" (built-in: ${Object.keys(BUILT_IN).join(', ')}; ` +
        'or a path to your own adapter module, such as ./my-adapter.js)',
    );
  }

  const file = path.resolve(configRoot, name);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new ConfigError(`adapter module not found: ${file}`);
  }
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (error) {
    throw new ConfigError(`cannot load adapter module ${file}: ${(error as Error).message}`);
  }
  if (typeof module.default !== 'function') {
    throw new ConfigError(`adapter module ${file} must export an adapter function as default`);
  }
  return module.default as Adapter;
}

function looksLikePath(name: string): boolean {
  return path.isAbsolute(name) || /[\\/]/.test(name);
}
