import { describe, expect, it } from 'vitest';

describe('package scaffold', () => {
  it('resolves the entry module', async () => {
    await expect(import('../src/index.js')).resolves.toBeDefined();
  });
});
