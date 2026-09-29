import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('embedded Qdrant dependency', () => {
  it('ships the client and initializes the real SDK against a local server', () => {
    const packageDir = fileURLToPath(new URL('../..', import.meta.url));
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    // Workspace optional-peer hoisting must not hide a missing published dependency.
    expect(manifest.dependencies).toHaveProperty('@qdrant/js-client-rest', expect.any(String));

    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import { createServer } from 'node:http';
      const { Qdrant } = await import('mem0ai/oss');
      const server = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(request.url === '/'
          ? { title: 'qdrant', version: '1.18.0' }
          : { status: 'ok', time: 0, result: request.url.endsWith('/points/scroll')
              ? { points: [], next_page_offset: null } : true }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const store = new Qdrant({
          url: 'http://127.0.0.1:' + server.address().port,
          collectionName: 'pi_memory_mem0_test',
          dimension: 3,
        });
        await store.initialize();
        process.stdout.write(JSON.stringify(await store.list({ user_id: 'test-user' })));
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `,
      ],
      { cwd: packageDir, encoding: 'utf8', timeout: 20_000 },
    );
    expect(JSON.parse(output)).toEqual([[], 0]);
  }, 30_000);
});
