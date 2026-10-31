import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { extractCodeBlocks } from '../src/checks/code-blocks.js';
import { typecheckSkill, validateTypecheck } from '../src/checks/typecheck.js';
import { ConfigError, type SkillSuite, type TypecheckConfig } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/typecheck/', import.meta.url));
const PRESET: TypecheckConfig = { preset: 'typescript', library: './lib/index.ts', blocking: true };

const ts = (code: string, info = 'ts'): string => '```' + info + '\n' + code + '\n```\n';

/** A skill whose SKILL.md is a title line, a blank line, then the given parts. */
function skill(...parts: string[]): SkillSuite {
  return {
    name: 'box',
    skillPath: path.join(FIXTURES, 'skills', 'box', 'SKILL.md'),
    skillText: '# Box\n\n' + parts.join('\n'),
    evalPath: path.join(FIXTURES, 'evals', 'box.json'),
    scenarios: [],
  };
}

function check(suite: SkillSuite, cfg: TypecheckConfig = PRESET) {
  return typecheckSkill(suite, cfg, FIXTURES);
}

describe('extractCodeBlocks', () => {
  it('returns each fenced block with its language, code, opening line and skip flag', () => {
    const markdown = [
      '# Title', //                1
      '```ts', //                  2
      'const a = 1;', //           3
      'const b = 2;', //           4
      '```', //                    5
      'Some text.', //             6
      '~~~TypeScript skip', //     7
      'nope(', //                  8
      '~~~', //                    9
      '```', //                    10
      'plain', //                  11
      '```', //                    12
    ].join('\r\n');

    expect(extractCodeBlocks(markdown)).toEqual([
      { lang: 'ts', code: 'const a = 1;\nconst b = 2;', line: 2, skip: false },
      { lang: 'typescript', code: 'nope(', line: 7, skip: true },
      { lang: '', code: 'plain', line: 10, skip: false },
    ]);
  });

  it('keeps a shorter fence inside a block and closes an unclosed block at the end', () => {
    const markdown = '````md\n```ts\nx\n```\n````\n\n```ts\nlast();\n';

    expect(extractCodeBlocks(markdown)).toEqual([
      { lang: 'md', code: '```ts\nx\n```', line: 1, skip: false },
      { lang: 'ts', code: 'last();', line: 7, skip: false },
    ]);
  });

  it('removes the fence indentation from an indented block', () => {
    const markdown = '- item\n\n  ```ts\n  if (a) {\n    b();\n  }\n  ```\n';

    expect(extractCodeBlocks(markdown)).toEqual([
      { lang: 'ts', code: 'if (a) {\n  b();\n}', line: 3, skip: false },
    ]);
  });
});

describe('typecheckSkill with the typescript preset', () => {
  it('passes a correct use of the library', async () => {
    const result = await check(skill(ts('box(1).map(x => x + 1).map(n => n.toFixed(2));')));

    expect(result).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('fails an unknown method with the skill, the SKILL.md line and the TS message', async () => {
    // SKILL.md: line 1 title, 2 blank, 3 fence, 4 first line, 5 second line.
    const result = await check(skill(ts('const b = box(1);\nb.mapp(x => x + 1);')));

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('skill "box"');
    expect(result.problems[0]).toContain('SKILL.md line 5');
    expect(result.problems[0]).toContain("Property 'mapp' does not exist on type 'Box<number>'");
  });

  it('fails a missing required argument', async () => {
    const result = await check(skill(ts('box();')));

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('TS2554');
    expect(result.problems[0]).toContain('Expected 1 arguments, but got 0');
  });

  it('fails a string where the signature needs a number', async () => {
    const result = await check(skill(ts("box('one');")));

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain(
      "Argument of type 'string' is not assignable to parameter of type 'number'",
    );
  });

  it('tolerates undeclared names, untyped parameters and unknown-typed values', async () => {
    const result = await check(
      skill(
        ts('e.map(x => x * 2);'),
        ts('function double(n) {\n  return box(n).map(x => x * 2);\n}'),
        ts('const user = Option.of(1).get() > 0 ? lookup(id) : none<User>();'),
        ts('function name(value: unknown) {\n  return value.name;\n}'),
      ),
    );

    expect(result).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('tolerates the "a(…) / b(…)" notation for alternatives, not arithmetic', async () => {
    const notation = await check(skill(ts('box(1) / Option.of(1)   // either form')));
    const arithmetic = await check(skill(ts("Option.of('a').get() * 2;")));

    expect(notation).toEqual({ ok: true, problems: [], warnings: [] });
    expect(arithmetic.problems[0]).toContain('TS2362');
  });

  it('compiles without the DOM lib, so a DOM global cannot shadow the library', async () => {
    // With the DOM lib, Option would be HTMLOptionElement and fetch would want 1-2 arguments.
    const good = await check(skill(ts('Option.of(1).get().toFixed(2);\nfetch(1, 2, 3);')));
    const bad = await check(skill(ts('Option.of(1).nope();')));

    expect(good).toEqual({ ok: true, problems: [], warnings: [] });
    expect(bad.problems[0]).toContain("Property 'nope' does not exist on type 'Option<number>'");
  });

  it('keeps the imports of earlier blocks of the same SKILL.md in scope', async () => {
    const result = await check(
      skill(ts("import { box as make } from 'boxlib';"), 'Then:\n', ts("make('one');")),
    );

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('SKILL.md line 10');
    expect(result.problems[0]).toContain("parameter of type 'number'");
  });

  it('keeps a type-only import of an earlier block type-only', async () => {
    const result = await check(
      skill(ts("import type { Box as B } from 'boxlib';"), 'Then:\n', ts('new B(1);')),
    );

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('SKILL.md line 10');
    expect(result.problems[0]).toContain("imported using 'import type'");
  });

  it('checks a block that imports the library itself', async () => {
    const result = await check(skill(ts("import { box } from 'boxlib';\n\nbox(1).mapp();")));

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('SKILL.md line 6');
  });

  it('fails an import of a name the library does not export', async () => {
    const result = await check(skill(ts("import { crate } from 'boxlib';")));

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("has no exported member 'crate'");
  });

  it('lets a block declare a name the library also exports', async () => {
    const block = ts("const box = (text: string) => text.length;\nbox('abc');");

    const result = await check(skill(block));

    expect(result).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('skips a block that does not parse, with a warning', async () => {
    const result = await check(
      skill(ts('box(1).map(async x => …);'), ts('box(1).map(x => x + 1);')),
    );

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('skill "box"');
    expect(result.warnings[0]).toContain('SKILL.md line 3');
    expect(result.warnings[0]).toContain('does not parse');
  });

  it('skips a block marked skip silently, and ignores blocks in other languages', async () => {
    const result = await check(
      skill(ts("box('one');", 'ts skip'), ts("box('one');", 'js'), ts('box(', 'typescript skip')),
    );

    expect(result).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('checks the names a per-skill prelude declares', async () => {
    const block = ts("box(inventory.count(3));\nbox(inventory.count('top'));");
    const withPrelude = { ...PRESET, preludes: { box: './preludes/boxes.d.ts' } };

    const without = await check(skill(block));
    const withIt = await check(skill(block), withPrelude);

    expect(without).toEqual({ ok: true, problems: [], warnings: [] });
    expect(withIt.problems).toHaveLength(1);
    expect(withIt.problems[0]).toContain('SKILL.md line 4');
    expect(withIt.problems[0]).toContain("parameter of type 'string'");
  });

  it('fails with a clear error when the prelude file is missing', async () => {
    const cfg = { ...PRESET, preludes: { box: './preludes/missing.d.ts' } };

    const error = await check(skill(ts('box(1);')), cfg).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('missing.d.ts');
  });

  it('fails with a clear error when the library cannot be resolved', async () => {
    const cfg = { ...PRESET, library: './lib/nowhere.ts' };

    const error = await check(skill(ts('box(1);')), cfg).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('nowhere.ts');
  });

  it('fails with a clear error when typescript is not installed', async () => {
    const missing = () => Promise.reject(new Error("Cannot find package 'typescript'"));

    const error = await typecheckSkill(skill(ts('box(1);')), PRESET, FIXTURES, {
      loadTypescript: missing,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('npm install --save-dev typescript');
  });

  describe('with the library given as a package name', () => {
    let root: string | undefined;

    afterEach(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
      root = undefined;
    });

    it('resolves the package from the root', async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'skill-be-typecheck-'));
      const pkg = path.join(root, 'node_modules', 'boxlib');
      await mkdir(pkg, { recursive: true });
      await copyFile(path.join(FIXTURES, 'lib', 'index.ts'), path.join(pkg, 'index.ts'));
      await writeFile(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: 'boxlib', types: './index.ts' }),
      );
      const cfg: TypecheckConfig = { preset: 'typescript', library: 'boxlib', blocking: true };

      const good = await typecheckSkill(skill(ts('box(1).map(x => x + 1);')), cfg, root);
      const bad = await typecheckSkill(skill(ts("box('one');")), cfg, root);

      expect(good).toEqual({ ok: true, problems: [], warnings: [] });
      expect(bad.problems[0]).toContain("parameter of type 'number'");
    });
  });
});

describe('typecheckSkill with a command', () => {
  const checker = path.join(FIXTURES, 'check-block.mjs');
  const cfg: TypecheckConfig = { command: `"${process.execPath}" "${checker}"`, blocking: true };

  it('passes each block on stdin and turns a non-zero exit into a problem', async () => {
    const result = await check(
      skill(ts('fine();'), ts('BAD();', 'python'), ts('BAD();', 'ts skip')),
      cfg,
    );

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('skill "box"');
    // A block-level problem names the block's opening fence.
    expect(result.problems[0]).toContain('SKILL.md line 7');
    expect(result.problems[0]).toContain('rejected (python): BAD();');
  });
});

// Runs against a local checkout of mini-fp-skills (SKILL_BE_SKILLS_REPO, its root) and the
// mini-fp source entry its skills document (SKILL_BE_MINI_FP_ENTRY); skipped without both.
const SKILLS_REPO = process.env.SKILL_BE_SKILLS_REPO;
const MINI_FP_ENTRY = process.env.SKILL_BE_MINI_FP_ENTRY;

describe.runIf(Boolean(SKILLS_REPO && MINI_FP_ENTRY))('the mini-fp-skills examples', () => {
  const SKILLS = path.join(SKILLS_REPO ?? '', 'skills');
  const LIBRARY = MINI_FP_ENTRY ?? '';
  const NAMES = [
    'async-pipelines',
    'either',
    'error-handling',
    'mini-fp',
    'option',
    'try',
    'utils',
    'validate',
    'validation-patterns',
  ];
  const cfg: TypecheckConfig = { preset: 'typescript', library: LIBRARY, blocking: true };

  async function suiteOf(name: string, edit = (text: string) => text): Promise<SkillSuite> {
    const { readFile } = await import('node:fs/promises');
    const skillPath = path.join(SKILLS, name, 'SKILL.md');
    const skillText = edit(await readFile(skillPath, 'utf8'));
    return { name, skillPath, skillText, evalPath: '', scenarios: [] };
  }

  it('typechecks all nine skills with zero problems', { timeout: 120_000 }, async () => {
    const warnings: string[] = [];
    for (const name of NAMES) {
      const result = await typecheckSkill(await suiteOf(name), cfg, SKILLS);
      expect(result.problems, name).toEqual([]);
      warnings.push(...result.warnings);
    }
    console.log(`warnings (${warnings.length}):\n${warnings.join('\n')}`);
  });

  it('fails a real misuse introduced in a copy', { timeout: 60_000 }, async () => {
    const suite = await suiteOf('option', (text) =>
      text.replace('opt.isSome()  //', 'Option.from(1).mapp(x => x)  //'),
    );

    const result = await typecheckSkill(suite, cfg, SKILLS);

    console.log(result.problems.join('\n'));
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("Property 'mapp' does not exist");
  });
});

describe('validateTypecheck', () => {
  const failureOf = (cfg: TypecheckConfig): Promise<unknown> =>
    validateTypecheck(cfg, FIXTURES).then(
      () => undefined,
      (caught: unknown) => caught,
    );

  it('accepts a preset whose library and preludes resolve', async () => {
    const cfg = { ...PRESET, preludes: { box: './preludes/boxes.d.ts' } };

    await expect(validateTypecheck(cfg, FIXTURES)).resolves.toBeUndefined();
  });

  it('accepts a command without running it', async () => {
    const cfg: TypecheckConfig = { command: 'skill-be-no-such-binary --check', blocking: true };

    await expect(validateTypecheck(cfg, FIXTURES)).resolves.toBeUndefined();
  });

  it.each([
    ['a library path that does not exist', { ...PRESET, library: './lib/x.ts' }, 'x.ts'],
    [
      'a library package that does not resolve',
      { ...PRESET, library: 'skill-be-no-such-lib' },
      'skill-be-no-such-lib',
    ],
    ['a missing prelude', { ...PRESET, preludes: { box: './missing.d.ts' } }, 'missing.d.ts'],
    ['a command with an unclosed quote', { command: 'node "x', blocking: true }, 'unclosed quote'],
    ['an empty command', { command: '  ', blocking: true }, 'checks.typecheck.command'],
  ])('throws a ConfigError for %s', async (_, cfg: TypecheckConfig, message) => {
    const error = await failureOf(cfg);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(message);
  });

  it('throws a ConfigError when typescript is not installed', async () => {
    const missing = () => Promise.reject(new Error("Cannot find package 'typescript'"));

    const error = await validateTypecheck(PRESET, FIXTURES, { loadTypescript: missing }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ConfigError);
  });
});
