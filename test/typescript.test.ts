import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTypescript, resolveTypescript } from '../src/checks/typescript.js';
import { typescriptInstalled } from '../src/config.js';

/** The `typescript` skill-be itself is installed with. */
const OWN = createRequire(import.meta.url).resolve('typescript');
const ownVersion = (createRequire(import.meta.url)('typescript') as { version: string }).version;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'skill-be-typescript-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A project whose node_modules has its own `typescript`, a stand-in that reports its version. */
async function projectWithTypescript(version: string): Promise<string> {
  const pkg = path.join(dir, 'node_modules', 'typescript');
  await mkdir(path.join(pkg, 'lib'), { recursive: true });
  await writeFile(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'typescript', version, main: './lib/typescript.js' }),
  );
  await writeFile(
    path.join(pkg, 'lib', 'typescript.js'),
    `module.exports = { version: ${JSON.stringify(version)} };\n`,
  );
  return path.join(pkg, 'lib', 'typescript.js');
}

describe('resolveTypescript', () => {
  it("prefers the project's own typescript", async () => {
    const file = await projectWithTypescript('5.9.3-project');

    expect(resolveTypescript(dir)).toBe(file);
  });

  it("falls back to skill-be's own typescript for a project without one", () => {
    expect(resolveTypescript(dir)).toBe(OWN);
  });
});

describe('loadTypescript', () => {
  it("loads the project's own typescript, the one the default typecheck was turned on for", async () => {
    await projectWithTypescript('5.9.3-project');

    const ts = await loadTypescript('typecheck', dir, {});

    expect(ts.version).toBe('5.9.3-project');
    expect(typescriptInstalled(dir)).toBe(true);
  });

  it("loads skill-be's own typescript for a project without one", async () => {
    const ts = await loadTypescript('typecheck', dir, {});

    expect(ts.version).toBe(ownVersion);
  });
});
