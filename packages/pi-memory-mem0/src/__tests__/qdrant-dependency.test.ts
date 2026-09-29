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
    // mem0ai 3.3.1 calls QdrantClient.search(), removed in @qdrant/js-client-rest 1.19.0.
    // Keep the range on 1.18.x until mem0ai no longer needs search().
    expect(manifest.dependencies['@qdrant/js-client-rest']).toMatch(/^~?1\.18\.\d+$/);

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
              ? { points: [], next_page_offset: null }
              : request.url.endsWith('/points/search') ? []
              : request.url.endsWith('/points/query') ? { points: [] } : true }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const store = new Qdrant({
          url: 'http://127.0.0.1:' + server.address().port,
          collectionName: 'pi_memory_mem0_test',
          dimension: 3,
        });
        await store.initialize();
        const listed = await store.list({ user_id: 'test-user' });
        const found = await store.search([0.1, 0.2, 0.3], 1, { user_id: 'test-user' });
        process.stdout.write(JSON.stringify({ listed, found }));
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `,
      ],
      { cwd: packageDir, encoding: 'utf8', timeout: 20_000 },
    );
    expect(JSON.parse(output)).toEqual({ listed: [[], 0], found: [] });
  }, 30_000);
});
