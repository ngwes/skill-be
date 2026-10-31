import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CompilerHost,
  CompilerOptions,
  Diagnostic,
  Extension,
  SourceFile,
  Symbol as TsSymbol,
  TypeChecker,
} from 'typescript';
import { ConfigError } from '../types.js';

/**
 * What the TypeScript presets (typecheck, coverage) share: loading the `typescript` package,
 * compiler options, and reading the exports of a library given as a package name or a source
 * entry.
 */

export type TypeScript = typeof import('typescript');

export type TypescriptDeps = {
  /** Loads the `typescript` package; a fake in tests. */
  loadTypescript?: () => Promise<TypeScript>;
};

/**
 * The file `typescript` resolves to for a project: from the project `root` first, else from
 * skillBe's own install (with npx, a global install or pnpm, the two differ). `undefined` when
 * neither has it. The default typecheck is turned on, and the presets load the compiler, by
 * this one lookup, so they always agree.
 */
export function resolveTypescript(root: string): string | undefined {
  // `createRequire` needs a file; the name does not have to exist.
  for (const base of [path.join(root, 'noop.js'), import.meta.url]) {
    try {
      return createRequire(base).resolve('typescript');
    } catch {
      // Not installed there; try the next place.
    }
  }
  return undefined;
}

/**
 * Loads `typescript` from where {@link resolveTypescript} finds it for `root`. `check` names the
 * preset that needs the package, for the error when it is missing.
 */
export async function loadTypescript(
  check: string,
  root: string,
  deps: TypescriptDeps,
): Promise<TypeScript> {
  const load = deps.loadTypescript ?? (() => importTypescript(root));
  try {
    return await load();
  } catch (error) {
    throw new ConfigError(
      `the ${check} preset needs the "typescript" package, which could not be loaded ` +
        `(${(error as Error).message}); install it: npm install --save-dev typescript`,
    );
  }
}

async function importTypescript(root: string): Promise<TypeScript> {
  const file = resolveTypescript(root);
  if (file === undefined) {
    throw new Error(`"typescript" resolves neither from ${root} nor from skillBe's own install`);
  }
  // The package is CommonJS: its exports are the default export of the ES module.
  return ((await import(pathToFileURL(file).href)) as { default: TypeScript }).default;
}

export type Library = {
  /** The module specifier the examples import the library by. */
  specifier: string;
  /** The library's source entry when it is given as a path; `specifier` resolves to it. */
  entry?: string;
};

/**
 * Without the DOM lib, a global such as `Option` or `fetch` cannot shadow the library. Without
 * `types`, no `@types` package adds globals either. `noImplicitAny` is off so that untyped
 * parameters pass. A file is a module only when it imports or exports, so a prelude without
 * imports declares global names, while every block (whose header always imports or exports) is
 * a module of its own.
 */
export function compilerOptions(ts: TypeScript): CompilerOptions {
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Legacy,
    lib: ['lib.esnext.d.ts'],
    types: [],
    strict: true,
    noImplicitAny: false,
    skipLibCheck: true,
    noEmit: true,
  };
}

/**
 * A source entry file, resolved against `root`; `what` names it in the error when it is missing.
 * The library is imported by the name of the nearest `package.json`, so examples that import the
 * published package compile against the source entry.
 */
export function resolveEntry(file: string, root: string, what: string): Library {
  const entry = path.resolve(root, file);
  if (!existsSync(entry)) throw new ConfigError(`${what} does not exist: ${entry}`);
  const specifier = packageName(path.dirname(entry)) ?? toTsPath(entry);
  return { specifier, entry: toTsPath(entry) };
}

function packageName(dir: string): string | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    const file = path.join(current, 'package.json');
    if (existsSync(file)) {
      try {
        const name = (JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }).name;
        return typeof name === 'string' && name !== '' ? name : undefined;
      } catch {
        return undefined;
      }
    }
    if (path.dirname(current) === current) return undefined;
  }
}

/** TypeScript names files with forward slashes. */
export function toTsPath(file: string): string {
  return file.replace(/\\/g, '/');
}

export type Host = { compilerHost: CompilerHost; files: Map<string, string> };

/**
 * A compiler host that serves virtual files, parses every other file once, and resolves the
 * library's specifier to its source entry when it is given as a path.
 */
export function createHost(
  ts: TypeScript,
  options: CompilerOptions,
  library: Library | undefined,
): Host {
  const files = new Map<string, string>();
  const parsed = new Map<string, SourceFile | undefined>();
  const host = ts.createCompilerHost(options, true);
  const { fileExists, readFile, getSourceFile } = host;

  host.fileExists = (fileName) => files.has(fileName) || fileExists.call(host, fileName);
  host.readFile = (fileName) => files.get(fileName) ?? readFile.call(host, fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = files.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    if (!parsed.has(fileName)) {
      const file = getSourceFile.call(host, fileName, languageVersion, onError, shouldCreate);
      parsed.set(fileName, file);
    }
    return parsed.get(fileName);
  };
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, settings) =>
    literals.map(({ text }) => {
      if (library?.entry !== undefined && text === library.specifier) {
        const resolvedFileName = library.entry;
        const extension = extensionOf(resolvedFileName);
        return { resolvedModule: { resolvedFileName, extension, isExternalLibraryImport: false } };
      }
      return ts.resolveModuleName(text, containingFile, settings, host, undefined, redirected);
    });
  return { compilerHost: host, files };
}

function extensionOf(fileName: string): Extension {
  const match = /(\.d\.[cm]?ts|\.[cm]?[jt]sx?)$/.exec(fileName);
  return (match?.[1] ?? '.ts') as Extension;
}

/**
 * The symbols the library exports, read through a probe file that re-exports it; `what` names
 * the library in the error when it cannot be loaded. The checker is returned for resolving
 * aliases and reading the members of classes.
 */
export function libraryExports(
  ts: TypeScript,
  host: Host,
  options: CompilerOptions,
  library: Library,
  virtualDir: string,
  what: string,
): { checker: TypeChecker; symbols: TsSymbol[] } {
  const probe = `${virtualDir}/library-probe.ts`;
  host.files.set(probe, `export * from ${JSON.stringify(library.specifier)};`);
  const program = ts.createProgram({ rootNames: [probe], options, host: host.compilerHost });
  const file = program.getSourceFile(probe)!;
  const error = program.getSemanticDiagnostics(file)[0];
  if (error !== undefined) {
    throw new ConfigError(
      `cannot load ${what} "${library.entry ?? library.specifier}": ${format(ts, error)}`,
    );
  }
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(file);
  return { checker, symbols: module === undefined ? [] : checker.getExportsOfModule(module) };
}

function message(ts: TypeScript, diagnostic: Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').replace(/\n\s*/g, ' ');
}

export function format(ts: TypeScript, diagnostic: Diagnostic): string {
  return `error TS${diagnostic.code}: ${message(ts, diagnostic)}`;
}
