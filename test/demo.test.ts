import { readdirSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';

// The README's two examples must stay the projects in test/fixtures/demo and test/fixtures/no-code,
// which must pass.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO = path.join(ROOT, 'test', 'fixtures', 'demo');
const SECTION = '## Example: test a skill end to end';
const NO_CODE = path.join(ROOT, 'test', 'fixtures', 'no-code');
const NO_CODE_SECTION = '## Example: test a skill without code';
const FENCE = '```';

const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const readme = (): string => lf(readFileSync(path.join(ROOT, 'README.md'), 'utf8'));

/** Every file under `dir`, as forward-slash paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

/**
 * The files an example section of the README shows in full: each is a `#### \`<path>\`` heading
 * followed by a fenced block, whose content (plus the final newline) is the file.
 */
function readmeFiles(section = SECTION): Map<string, string> {
  const lines = readme().split('\n');
  const start = lines.indexOf(section);
  expect(start, `README.md has no "${section}" section`).toBeGreaterThan(-1);

  const files = new Map<string, string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    // Skip any other code block whole, so a heading inside it does not count.
    const other = /^(`{3,})/.exec(line);
    if (other !== null) {
      const opening = i;
      i = lines.indexOf(other[1] as string, i + 1);
      expect(i, `the code block at README.md line ${opening + 1} is not closed`).toBeGreaterThan(-1);
      continue;
    }
    if (line.startsWith('## ')) break;
    const heading = /^#### `([^`]+)`$/.exec(line);
    if (heading === null) continue;
    let open = i + 1;
    while (lines[open] === '') open++;
    const fence = /^(`{3,})\S*$/.exec(lines[open] ?? '');
    expect(fence, `no code block after the heading of ${heading[1]}`).not.toBeNull();
    const close = lines.indexOf(fence![1] as string, open + 1);
    expect(close, `the code block of ${heading[1]} is not closed`).toBeGreaterThan(open);
    files.set(heading[1] as string, `${lines.slice(open + 1, close).join('\n')}\n`);
    i = close;
  }
  return files;
}

/** True when README.md shows `output` as a whole, untagged code block. */
function readmeShows(output: string): boolean {
  return readme().includes(`\n${FENCE}\n${output}${FENCE}\n`);
}

/** What `skill-be check` prints for the demo project in `dir`. */
async function check(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await main(['check', '--config', path.join(dir, 'skill-be.yaml')], {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    cwd: ROOT,
  });
  return { code, stdout, stderr };
}

describe('the README example', () => {
  it('shows every file of test/fixtures/demo, and only those', () => {
    expect([...readmeFiles().keys()].sort()).toEqual(filesUnder(DEMO));
  });

  it('shows each file exactly as it is in test/fixtures/demo', () => {
    for (const [file, text] of readmeFiles()) {
      expect(text, file).toBe(lf(readFileSync(path.join(DEMO, file), 'utf8')));
    }
  });

  it('uses claude-cli and checks the library with relative paths', async () => {
    const config = await loadConfig(path.join(DEMO, 'skill-be.yaml'));

    expect(config.models.map((model) => model.adapter)).toEqual(['claude-cli']);
    expect(config.grader.adapter).toBe('claude-cli');
    expect(config.checks.typecheck).toMatchObject({ preset: 'typescript' });
    expect(config.checks.coverage).toMatchObject({ preset: 'typescript' });
  });

  it('passes check with no typecheck problem and no coverage gap', { timeout: 60_000 }, async () => {
    const { code, stdout, stderr } = await check(DEMO);

    expect(stderr).toBe('');
    expect(stdout).toBe(
      'typecheck: passed (1 skill(s))\ncoverage: every API name is mentioned\nResult: pass\n',
    );
    expect(code).toBe(0);
    expect(readmeShows(stdout), 'the README shows this output').toBe(true);
  });

  it('fails check on the broken example the README shows', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'skill-be-demo-'));
    try {
      await cp(DEMO, dir, { recursive: true });
      const skill = path.join(dir, 'skills', 'money', 'SKILL.md');
      const text = await readFile(skill, 'utf8');
      expect(text.split('.allocate([1, 1, 1]);')).toHaveLength(2);
      await writeFile(skill, text.replace('.allocate([1, 1, 1]);', '.allocate(1, 1, 1);'));

      const { code, stdout, stderr } = await check(dir);

      expect(stderr).toBe('');
      expect(stdout).toContain('error TS2554');
      expect(code).toBe(1);
      expect(readmeShows(stdout), `the README shows this output:\n${stdout}`).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the README example without code', () => {
  it('shows every file of test/fixtures/no-code, and only those', () => {
    expect([...readmeFiles(NO_CODE_SECTION).keys()].sort()).toEqual(filesUnder(NO_CODE));
  });

  it('shows each file exactly as it is in test/fixtures/no-code', () => {
    for (const [file, text] of readmeFiles(NO_CODE_SECTION)) {
      expect(text, file).toBe(lf(readFileSync(path.join(NO_CODE, file), 'utf8')));
    }
  });

  it('replaces the template and the grader prompt, and turns the checks off', async () => {
    const config = await loadConfig(path.join(NO_CODE, 'skill-be.yaml'));

    expect(config.withSkillTemplate).not.toMatch(/library|code/i);
    expect(config.graderPrompt).toMatch(/document/);
    expect(config.checks.typecheck).toBe(false);
    expect(config.checks.coverage).toBe(false);
  });

  it('passes check', async () => {
    const { code, stdout, stderr } = await check(NO_CODE);

    expect(stderr).toBe('');
    expect(stdout).toBe('typecheck: off\ncoverage: off\nResult: pass\n');
    expect(code).toBe(0);
    expect(readmeShows(stdout), 'the README shows this output').toBe(true);
  });
});
