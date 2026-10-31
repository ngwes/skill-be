import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Either, Option, TryAsync, type EitherAsync } from '@ngwes/mini-fp';
import { valueOrThrow } from '../checked.js';
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
export function resolveAdapter(name: string, configRoot: string): Promise<Adapter> {
  const builtIn = Object.prototype.hasOwnProperty.call(BUILT_IN, name) ? BUILT_IN[name] : undefined;
  return Option.from(builtIn).matchAsync(
    (adapter) => adapter,
    async () => valueOrThrow(await moduleAdapter(name, configRoot)),
  );
}

/** The default export of the adapter module at `name`, or why it cannot be one. */
function moduleAdapter(name: string, configRoot: string): EitherAsync<string, Adapter> {
  const file = path.resolve(configRoot, name);
  return Either.right<string, string>(name)
    .bind((candidate) =>
      looksLikePath(candidate)
        ? Either.right<string, string>(file)
        : Either.left<string, string>(
            `unknown adapter "${name}" (built-in: ${Object.keys(BUILT_IN).join(', ')}; ` +
              'or a path to your own adapter module, such as ./my-adapter.js)',
          ),
    )
    .bind((found) =>
      statSync(found, { throwIfNoEntry: false })?.isFile()
        ? Either.right<string, string>(found)
        : Either.left<string, string>(`adapter module not found: ${found}`),
    )
    .bindAsync((found) =>
      TryAsync.runAsync(() => import(pathToFileURL(found).href) as Promise<{ default?: unknown }>)
        .toEither()
        .mapLeft((error) => `cannot load adapter module ${found}: ${(error as Error).message}`),
    )
    .bind((module) =>
      typeof module.default === 'function'
        ? Either.right<string, Adapter>(module.default as Adapter)
        : Either.left<string, Adapter>(
            `adapter module ${file} must export an adapter function as default`,
          ),
    );
}

function looksLikePath(name: string): boolean {
  return path.isAbsolute(name) || /[\\/]/.test(name);
}
