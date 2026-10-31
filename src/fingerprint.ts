/**
 * The fingerprint of a skill: a SHA-256 over its `SKILL.md`, its eval file and the config file.
 *
 * It lets `verify` tell, without a model call, that a skill changed since its last run. The files
 * are hashed with CRLF turned into LF, so a Windows checkout matches a Linux one, and each is
 * named by its path relative to the config root, written with forward slashes, so the same
 * project hashes the same wherever it sits on disk.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { foldAsync } from '@ngwes/mini-fp';
import type { Config, SkillSuite } from './types.js';

/**
 * The SHA-256 (hex) of the files, in the order given. For each file it hashes
 * `<path relative to root>\0<byte length>\0<content with LF line endings>`, so neither the name
 * nor the order nor the split between files can be shifted without changing the result.
 */
export async function fingerprint(files: string[], root: string): Promise<string> {
  const hash = await foldAsync(files, createHash('sha256'), async (partial, file) => {
    const content = lineFeeds(await readFile(file));
    return partial.update(`${relativeName(root, file)}\0${content.length}\0`).update(content);
  });
  return hash.digest('hex');
}

/** The fingerprint of one skill: its `SKILL.md`, its eval file and the config file, in turn. */
export function skillFingerprint(config: Config, suite: SkillSuite): Promise<string> {
  return fingerprint([suite.skillPath, suite.evalPath, config.configPath], config.root);
}

/** The bytes with every CRLF turned into LF. Latin-1 maps bytes to characters one to one. */
function lineFeeds(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

function relativeName(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
