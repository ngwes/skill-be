import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { fingerprint, skillFingerprint } from '../src/fingerprint.js';
import { loadSuites } from '../src/suite.js';

const dirs: string[] = [];

/** A fresh temporary directory, removed after the test. */
async function tempDir(prefix = 'skill-be-fingerprint-'): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(created);
  return created;
}

let dir: string;

beforeEach(async () => {
  dir = await tempDir();
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function put(root: string, name: string, content: string | Buffer): Promise<string> {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

describe('fingerprint', () => {
  it('is a SHA-256 in hex', async () => {
    const file = await put(dir, 'a.txt', 'hello\n');

    expect(await fingerprint([file], dir)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same for the same files', async () => {
    const file = await put(dir, 'a.txt', 'hello\n');

    expect(await fingerprint([file], dir)).toBe(await fingerprint([file], dir));
  });

  it('is the same whether the lines end in LF or CRLF', async () => {
    const lf = await tempDir();
    const crlf = await tempDir();
    const a = await put(lf, 'skills/x/SKILL.md', '# X\n\nline one\nline two\n');
    const b = await put(crlf, 'skills/x/SKILL.md', '# X\r\n\r\nline one\r\nline two\r\n');

    expect(await fingerprint([b], crlf)).toBe(await fingerprint([a], lf));
  });

  it('tells a lone CR from a line ending', async () => {
    const lone = await put(dir, 'lone.md', 'a\rb\n');
    const lf = await put(dir, 'lf.md', 'a\nb\n');

    expect(await fingerprint([lone], dir)).not.toBe(await fingerprint([lf], dir));
  });

  it('changes when one byte of a file changes', async () => {
    const file = await put(dir, 'a.txt', 'hello\n');
    const before = await fingerprint([file], dir);

    await writeFile(file, 'hellp\n');

    expect(await fingerprint([file], dir)).not.toBe(before);
  });

  it('tells apart bytes that are not valid UTF-8', async () => {
    const file = await put(dir, 'a.bin', Buffer.from([0x61, 0xff, 0x62]));
    const before = await fingerprint([file], dir);

    await writeFile(file, Buffer.from([0x61, 0xfe, 0x62]));

    expect(await fingerprint([file], dir)).not.toBe(before);
  });

  it('depends on the order of the files', async () => {
    const a = await put(dir, 'a.txt', 'one');
    const b = await put(dir, 'b.txt', 'two');

    expect(await fingerprint([a, b], dir)).not.toBe(await fingerprint([b, a], dir));
  });

  it('depends on the path of a file relative to the root, not only on its content', async () => {
    const x = await put(dir, 'skills/x/SKILL.md', 'same');
    const y = await put(dir, 'skills/y/SKILL.md', 'same');

    expect(await fingerprint([y], dir)).not.toBe(await fingerprint([x], dir));
  });

  it('does not depend on where the project sits on disk', async () => {
    const other = await tempDir();
    const here = await put(dir, 'skills/x/SKILL.md', 'same');
    const there = await put(other, 'skills/x/SKILL.md', 'same');

    expect(await fingerprint([there], other)).toBe(await fingerprint([here], dir));
  });

  it('does not let content move from one file to the next', async () => {
    const one = await put(dir, 'one/a.txt', 'ab');
    const two = await put(dir, 'one/b.txt', 'c');
    const three = await put(dir, 'two/a.txt', 'a');
    const four = await put(dir, 'two/b.txt', 'bc');

    expect(await fingerprint([one, two], dir)).not.toBe(await fingerprint([three, four], dir));
  });

  it('keeps the value it had, so that committed result files stay valid', async () => {
    // The digest of `<path>\0<byte length>\0<content with LF>` for each file in turn, with the
    // path relative to the root and written with forward slashes, whatever the platform. The
    // value was computed outside this module.
    const a = await put(dir, 'skills/x/SKILL.md', '# X\r\nbody\r\n');
    const b = await put(dir, 'skill-be.yaml', 'skills: ./skills\n');

    expect(await fingerprint([a, b], dir)).toBe(
      '26b31654828e7fb624ab52720e46ecada95bfebe5c5b05b78c0c3539465ee384',
    );
  });

  it('rejects when a file cannot be read', async () => {
    await expect(fingerprint([path.join(dir, 'missing.txt')], dir)).rejects.toThrow('missing.txt');
  });
});

const CONFIG_YAML = [
  'skills: ./skills',
  'evals: ./evals',
  'model:',
  '  adapter: command',
  '  id: fake',
  'grader:',
  '  adapter: command',
  '  id: fake',
  '',
].join('\n');
const EVAL_JSON =
  JSON.stringify(
    {
      scenarios: [{ id: 's1', critical: false, prompt: 'Do it.', criteria: ['It is done'] }],
    },
    null,
    2,
  ) + '\n';
const SKILL_MD = '# Skill A\n\nUse double().\n';

const crlf = (text: string): string => text.replace(/\n/g, '\r\n');

async function project(
  root: string,
  files: { skill?: string; evals?: string; config?: string } = {},
) {
  await put(root, 'skills/a/SKILL.md', files.skill ?? SKILL_MD);
  await put(root, 'evals/a.json', files.evals ?? EVAL_JSON);
  const configFile = await put(root, 'skill-be.yaml', files.config ?? CONFIG_YAML);
  const config = await loadConfig(configFile, { typescriptInstalled: () => false });
  const { suites } = await loadSuites(config);
  return { config, suite: suites[0]! };
}

describe('skillFingerprint', () => {
  it('is the same when nothing changed', async () => {
    const { config, suite } = await project(dir);

    expect(await skillFingerprint(config, suite)).toBe(await skillFingerprint(config, suite));
  });

  it('is the same for the same project in another directory', async () => {
    const other = await tempDir();
    const here = await project(dir);
    const there = await project(other);

    expect(await skillFingerprint(there.config, there.suite)).toBe(
      await skillFingerprint(here.config, here.suite),
    );
  });

  it('is the same for a checkout with CRLF line endings', async () => {
    const other = await tempDir();
    const lf = await project(dir);
    const windows = await project(other, {
      skill: crlf(SKILL_MD),
      evals: crlf(EVAL_JSON),
      config: crlf(CONFIG_YAML),
    });

    expect(await skillFingerprint(windows.config, windows.suite)).toBe(
      await skillFingerprint(lf.config, lf.suite),
    );
  });

  it('changes when SKILL.md changes by one byte', async () => {
    const { config, suite } = await project(dir);
    const before = await skillFingerprint(config, suite);

    await put(dir, 'skills/a/SKILL.md', SKILL_MD.replace('double', 'doublf'));

    expect(await skillFingerprint(config, suite)).not.toBe(before);
  });

  it('changes when the eval file changes by one byte', async () => {
    const { config, suite } = await project(dir);
    const before = await skillFingerprint(config, suite);

    await put(dir, 'evals/a.json', EVAL_JSON.replace('Do it.', 'Do it!'));

    expect(await skillFingerprint(config, suite)).not.toBe(before);
  });

  it('changes when the config file changes by one byte', async () => {
    const { config, suite } = await project(dir);
    const before = await skillFingerprint(config, suite);

    await put(dir, 'skill-be.yaml', CONFIG_YAML.replace('id: fake', 'id: fakf'));

    expect(await skillFingerprint(config, suite)).not.toBe(before);
  });

  it('does not change when another skill changes', async () => {
    const { config, suite } = await project(dir);
    const before = await skillFingerprint(config, suite);

    await put(dir, 'skills/b/SKILL.md', '# Skill B\n');
    await put(dir, 'evals/b.json', EVAL_JSON);

    expect(await skillFingerprint(config, suite)).toBe(before);
  });
});
