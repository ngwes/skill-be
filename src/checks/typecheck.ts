import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BindingName, Diagnostic, Node, SourceFile, Statement } from 'typescript';
import { splitCommandLine } from '../adapters/command.js';
import { runProcess } from '../process.js';
import { ConfigError, type SkillSuite, type TypecheckConfig } from '../types.js';
import { extractCodeBlocks, type CodeBlock } from './code-blocks.js';
import {
  compilerOptions,
  createHost,
  format,
  libraryExports,
  loadTypescript,
  resolveEntry,
  toTsPath,
  type Library,
  type TypeScript,
  type TypescriptDeps,
} from './typescript.js';

export type TypecheckResult = { ok: boolean; problems: string[]; warnings: string[] };

export type TypecheckDeps = TypescriptDeps;

/**
 * The diagnostics the preset tolerates. The preset checks fragments, not programs: examples use
 * names they never declare (`db`, `user`, `fetchUser`) and values of type `unknown` (a caught
 * error), and neither says anything about how the library's API is used. Every other error fails,
 * so a wrong argument type, an unknown method or a wrong arity on a library function still fails.
 */
const TOLERATED = new Set([
  2304, // Cannot find name 'x'.
  2552, // Cannot find name 'x'. Did you mean 'y'?
  // Cannot find name 'console'; change the 'lib' option to include 'dom'. The same unknown name
  // as 2304, raised for the DOM globals the preset leaves out (examples log with `console`). A
  // library export is always in scope, so this is never a library name.
  2584,
  18046, // 'x' is of type 'unknown'.
]);

/**
 * "The left-hand (right-hand) side of an arithmetic operation must be of type 'any', 'number'…":
 * tolerated only on `a(…) / b(…)`, the notation examples use for "either form"
 * (`Either.right(value) / Either.left(error)`). Both operands must be calls, so arithmetic on a
 * value the library returned (`opt.map(s => s * 2)` with a string `s`) still fails.
 */
const ARITHMETIC_OPERAND = [2362, 2363];

/** How long the typecheck command may take on one block. */
const COMMAND_TIMEOUT_MS = 60_000;

/** The blocks the preset compiles. */
const TYPESCRIPT_LANGS = ['ts', 'typescript'];

/**
 * Checks the code examples of a skill. With `cfg.command`, every non-skipped block with a
 * language goes to the command on stdin; otherwise the TypeScript preset compiles the `ts` and
 * `typescript` blocks against the library. Paths in `cfg` are relative to `root`.
 */
export async function typecheckSkill(
  suite: SkillSuite,
  cfg: TypecheckConfig,
  root: string,
  deps: TypecheckDeps = {},
): Promise<TypecheckResult> {
  const blocks = extractCodeBlocks(suite.skillText).filter((block) => !block.skip);
  const { problems, warnings } =
    cfg.command !== undefined
      ? await runCommand(suite, blocks, cfg.command, root)
      : await compile(await loadTypescript('typecheck', root, deps), suite, blocks, cfg, root);
  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Checks the typecheck settings without checking a skill, so that a run can stop before its
 * first model call: the command line splits into a command, or the preset finds `typescript`,
 * the library (whose exports it loads) and every prelude. The command is not started.
 *
 * @throws ConfigError naming the setting that is wrong.
 */
export async function validateTypecheck(
  cfg: TypecheckConfig,
  root: string,
  deps: TypecheckDeps = {},
): Promise<void> {
  if (cfg.command !== undefined) {
    commandWords(cfg.command);
    return;
  }
  const ts = await loadTypescript('typecheck', root, deps);
  for (const [skill, prelude] of Object.entries(cfg.preludes ?? {})) {
    preludeFile(skill, prelude, root);
  }
  if (cfg.library === undefined) return;
  const library = resolveLibrary(cfg.library, root);
  const options = compilerOptions(ts);
  const virtualDir = toTsPath(path.join(path.resolve(root), '.skillbe-typecheck'));
  const host = createHost(ts, options, library);
  libraryExports(ts, host, options, library, virtualDir, TYPECHECK_LIBRARY);
}

/** The command and its arguments, from `checks.typecheck.command`. */
function commandWords(command: string): [string, ...string[]] {
  const [bin, ...args] = splitCommandLine(command, '"checks.typecheck.command"');
  if (bin === undefined || bin === '') {
    throw new ConfigError(`"checks.typecheck.command" has no command: ${command}`);
  }
  return [bin, ...args];
}

/** The absolute path of a skill's prelude, which must exist. */
function preludeFile(skill: string, prelude: string, root: string): string {
  const file = path.resolve(root, prelude);
  if (!existsSync(file)) {
    throw new ConfigError(`the typecheck prelude of skill "${skill}" does not exist: ${file}`);
  }
  return file;
}

const TYPECHECK_LIBRARY = 'the typecheck library';

const PATH_LIKE = /^(\.{1,2}[\\/]|[\\/])|\.[cm]?tsx?$/;

/** A library is a package name or, when it looks like a path, a source entry. */
function resolveLibrary(library: string, root: string): Library {
  if (!PATH_LIKE.test(library) && !path.isAbsolute(library)) return { specifier: library };
  return resolveEntry(library, root, TYPECHECK_LIBRARY);
}

function where(suite: SkillSuite, line: number): string {
  return `skill "${suite.name}", SKILL.md line ${line}`;
}

/** Passes each block with a language to the command on stdin; a non-zero exit is a problem. */
async function runCommand(
  suite: SkillSuite,
  blocks: CodeBlock[],
  command: string,
  root: string,
): Promise<{ problems: string[]; warnings: string[] }> {
  const [bin, ...args] = commandWords(command);

  const problems: string[] = [];
  for (const block of blocks.filter((candidate) => candidate.lang !== '')) {
    const result = await runProcess({
      bin,
      args,
      stdin: block.code + '\n',
      timeoutMs: COMMAND_TIMEOUT_MS,
      cwd: root,
      env: { ...process.env, SKILLBE_LANG: block.lang, SKILLBE_SKILL: suite.name },
    }).catch((error: unknown) => {
      throw new ConfigError(`the typecheck command failed to start (${(error as Error).message})`);
    });
    if (result.timedOut) {
      problems.push(
        `${where(suite, block.line)}: the typecheck command timed out after ` +
          `${COMMAND_TIMEOUT_MS / 1000} s`,
      );
    } else if (result.code !== 0) {
      const output = (result.stderr.trim() || result.stdout.trim()).slice(-2000);
      problems.push(
        `${where(suite, block.line)}: the typecheck command failed ` +
          `(exit code ${result.code})${output === '' ? '' : `: ${output}`}`,
      );
    }
  }
  return { problems, warnings: [] };
}

/** A compiled block: its virtual file holds a one-line header, then the block's code. */
type Unit = { block: CodeBlock; fileName: string };

async function compile(
  ts: TypeScript,
  suite: SkillSuite,
  blocks: CodeBlock[],
  cfg: TypecheckConfig,
  root: string,
): Promise<{ problems: string[]; warnings: string[] }> {
  const options = compilerOptions(ts);
  const library = cfg.library === undefined ? undefined : resolveLibrary(cfg.library, root);
  const prelude = cfg.preludes?.[suite.name];
  const preludePath = prelude === undefined ? undefined : preludeFile(suite.name, prelude, root);

  // Virtual files live under the root, so a package name resolves from the root's node_modules.
  const virtualDir = toTsPath(path.join(path.resolve(root), '.skillbe-typecheck', suite.name));
  const host = createHost(ts, options, library);

  const exports =
    library === undefined
      ? []
      : libraryExports(ts, host, options, library, virtualDir, TYPECHECK_LIBRARY).symbols;
  const exportNames = exports.map((symbol) => symbol.name);

  const warnings: string[] = [];
  const units: Unit[] = [];
  /** The imports of the earlier blocks: local name → an import statement binding only it. */
  const carried = new Map<string, string>();
  for (const block of blocks.filter((candidate) => TYPESCRIPT_LANGS.includes(candidate.lang))) {
    const syntaxError = firstSyntaxError(ts, block.code);
    if (syntaxError !== undefined) {
      warnings.push(
        `${where(suite, block.line)}: the block does not parse, skipped (${syntaxError})`,
      );
      continue;
    }
    const source = ts.createSourceFile('block.ts', block.code, ts.ScriptTarget.ESNext, true);
    const declared = topLevelNames(ts, source.statements);
    const header = headerFor(declared, carried, exportNames, library);
    const fileName = `${virtualDir}/block-line-${block.line}.ts`;
    host.files.set(fileName, header + '\n' + block.code);
    units.push({ block, fileName });
    for (const [name, statement] of importBindings(ts, source)) carried.set(name, statement);
  }

  const rootNames = units.map((unit) => unit.fileName);
  if (preludePath !== undefined) rootNames.push(toTsPath(preludePath));
  const program = ts.createProgram({ rootNames, options, host: host.compilerHost });

  const problems: string[] = [];
  for (const unit of units) {
    const file = program.getSourceFile(unit.fileName)!;
    for (const diagnostic of failing(ts, program.getSemanticDiagnostics(file))) {
      const line = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
      // Line 0 is the header, whose imports were already checked in the block they came from.
      if (line === 0) continue;
      problems.push(`${where(suite, unit.block.line + line)}: ${format(ts, diagnostic)}`);
    }
  }
  if (preludePath !== undefined) {
    const file = program.getSourceFile(toTsPath(preludePath))!;
    const diagnostics = [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ];
    for (const diagnostic of failing(ts, diagnostics)) {
      const line = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
      problems.push(
        `skill "${suite.name}", prelude ${preludePath} line ${line}: ${format(ts, diagnostic)}`,
      );
    }
  }
  return { problems, warnings };
}

/** The first syntax error of a block, formatted, or undefined when the block parses. */
function firstSyntaxError(ts: TypeScript, code: string): string | undefined {
  const { diagnostics = [] } = ts.transpileModule(code, {
    fileName: 'block.ts',
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  const error = diagnostics.find(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  return error === undefined ? undefined : format(ts, error);
}

/**
 * The header of a block, on one line so the block's lines keep their numbers: the imports of
 * earlier blocks and the library's exports, minus every name the block declares itself.
 */
function headerFor(
  declared: Set<string>,
  carried: Map<string, string>,
  exports: string[],
  library: Library | undefined,
): string {
  const statements = [...carried].filter(([name]) => !declared.has(name)).map(([, text]) => text);
  const names = exports.filter((name) => !declared.has(name) && !carried.has(name));
  if (library !== undefined && names.length > 0) {
    statements.push(`import { ${names.join(', ')} } from ${JSON.stringify(library.specifier)};`);
  }
  statements.push('export {};');
  return statements.join(' ');
}

/** The names a block declares at its top level, its imports included. */
function topLevelNames(ts: TypeScript, statements: readonly Statement[]): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBinding(element.name);
    }
  };

  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBinding(declaration.name);
      }
    } else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name !== undefined) names.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.add(element.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)) &&
      statement.name !== undefined &&
      ts.isIdentifier(statement.name)
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

/** Each name a block imports, with an import statement that binds only that name. */
function importBindings(ts: TypeScript, source: SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of source.statements.filter(ts.isImportDeclaration)) {
    const clause = statement.importClause;
    if (clause === undefined) continue;
    const from = statement.moduleSpecifier.getText(source);
    // `phaseModifier` exists since TypeScript 5.9; before it, only `isTypeOnly` says `import type`.
    const typeOnly =
      clause.phaseModifier === undefined
        ? clause.isTypeOnly
        : clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
    const type = typeOnly ? 'type ' : '';
    if (clause.name !== undefined) {
      bindings.set(clause.name.text, `import ${type}${clause.name.text} from ${from};`);
    }
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamespaceImport(named)) {
      bindings.set(named.name.text, `import ${type}* as ${named.name.text} from ${from};`);
    }
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.set(
          element.name.text,
          `import ${type}{ ${element.getText(source)} } from ${from};`,
        );
      }
    }
  }
  return bindings;
}

/** The errors the preset does not tolerate. */
function failing(ts: TypeScript, diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.category === ts.DiagnosticCategory.Error && !tolerated(ts, diagnostic),
  );
}

function tolerated(ts: TypeScript, diagnostic: Diagnostic): boolean {
  if (TOLERATED.has(diagnostic.code)) return true;
  if (!ARITHMETIC_OPERAND.includes(diagnostic.code)) return false;
  const parent = nodeOf(ts, diagnostic)?.parent;
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.SlashToken &&
    ts.isCallExpression(parent.left) &&
    ts.isCallExpression(parent.right)
  );
}

/** The outermost node whose text is exactly the span a diagnostic points at. */
function nodeOf(ts: TypeScript, diagnostic: Diagnostic): Node | undefined {
  const { file, start, length } = diagnostic;
  if (file === undefined || start === undefined || length === undefined) return undefined;
  let match: Node | undefined;
  const visit = (node: Node): void => {
    if (match !== undefined || start < node.pos || start >= node.end) return;
    if (node.getStart(file) === start && node.end === start + length) match = node;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return match;
}
