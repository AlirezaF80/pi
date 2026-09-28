import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('embedded Mem0 optional peers', () => {
  it('initializes the memory store without loading pg', () => {
    const packageDir = fileURLToPath(new URL('../..', import.meta.url));
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'pg') throw new Error('unexpected pg import');
        return nextResolve(specifier, context);
      } });
      const { Memory } = await import('mem0ai/oss');
      const memory = new Memory({
        embedder: { provider: 'openai', config: { apiKey: 'unused' } },
        llm: { provider: 'openai', config: { apiKey: 'unused' } },
        vectorStore: { provider: 'memory', config: { dimension: 3, dbPath: ':memory:' } },
        disableHistory: true,
      });
      const result = await memory.getAll({ filters: { user_id: '__warmup__' } });
      process.stdout.write(String(Array.isArray(result.results)));
    `,
      ],
      { cwd: packageDir, encoding: 'utf8' },
    );
    expect(output).toBe('true');
  });
});
