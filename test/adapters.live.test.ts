// Real model calls through each CLI and its stored login. Run with SKILL_BE_LIVE=1.
// SKILL_BE_LIVE_OPENCODE_MODEL picks the opencode model as provider/model.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveAdapter } from '../src/adapters/index.js';
import type { AdapterSettings } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIVE = process.env.SKILL_BE_LIVE === '1';
const TIMEOUT_MS = 120_000;
const PROMPT = 'Reply with exactly: ok';

const [opencodeProvider, ...opencodeModel] = (
  process.env.SKILL_BE_LIVE_OPENCODE_MODEL ?? 'anthropic/claude-haiku-5-5'
).split('/');

const cases: AdapterSettings[] = [
  { adapter: 'claude-cli', id: 'claude-haiku-5-5' },
  { adapter: 'pi-cli', id: 'claude-haiku-5-5', provider: 'anthropic' },
  { adapter: 'opencode-cli', id: opencodeModel.join('/'), provider: opencodeProvider },
];

describe.runIf(LIVE)('live adapters', () => {
  for (const settings of cases) {
    const name = `${settings.adapter} (${String(settings.provider ?? 'own')}/${settings.id})`;
    it(`${name} answers "${PROMPT}"`, { timeout: TIMEOUT_MS + 10_000 }, async () => {
      const adapter = await resolveAdapter(settings.adapter, ROOT);

      const answer = await adapter(PROMPT, { settings, timeoutMs: TIMEOUT_MS, cwd: ROOT });

      console.log(`${name}: ${JSON.stringify(answer)}`);
      expect(answer.toLowerCase()).toContain('ok');
    });
  }
});
