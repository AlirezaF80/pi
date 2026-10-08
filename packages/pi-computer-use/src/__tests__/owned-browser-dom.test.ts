import { describe, expect, it, vi } from 'vitest';
import { OwnedBrowserDomReader } from '../owned-browser-dom.js';

const initial = {
  pid: 4200,
  created: '2026-10-08T10:00:00.000Z',
  commandLine: 'chrome.exe --user-data-dir=C:\\temp\\pi-isolated',
  profile: 'C:\\temp\\pi-isolated',
  port: 51000,
  activePort: '51000\n/devtools/browser/owned',
};
const page = {
  id: 'page-target-1',
  type: 'page',
  url: 'https://example.com/product',
  webSocketDebuggerUrl: 'ws://127.0.0.1:51000/devtools/page/page-target-1',
};

function setup(pages = [page]) {
  let identity = { ...initial };
  const boundary = {
    capture: vi.fn(async () => ({ ...identity })),
    pages: vi.fn(async () => pages),
    read: vi.fn(async (nativePage: { startIndex?: number }) => {
      const start = nativePage.startIndex ?? 0;
      const count = start === 0 ? 20 : 5;
      return JSON.stringify({
        matches: Array.from({ length: count }, (_, index) => ({ text: `Product ${start + index}`, attributes: { href: '/product' } })),
        start_index: start,
        total_matches: 25,
        omitted_matches: Math.max(0, 25 - start - count),
        next_index: start + count,
        has_more: start + count < 25,
        truncated: false,
      });
    }),
  };
  return { reader: new OwnedBrowserDomReader(boundary), boundary, changeIdentity(next: typeof initial) { identity = next; } };
}

describe('OwnedBrowserDomReader', () => {
  it('binds one native tab to one owned page and returns bounded DOM content', async () => {
    const { reader, boundary } = setup();
    await reader.rememberPrepared(4200);
    await reader.bind('native-target', 'native-tab', 4200, page.url);
    const result = await reader.read('native-target', 'native-tab', 'h1');

    expect(boundary.pages).toHaveBeenCalledTimes(3);
    expect(boundary.read).toHaveBeenCalledWith({ ...page, selector: 'h1' }, 51000, undefined);
    expect(result.content[0]?.text).toContain('Product 0');
    expect(result.details).toEqual({ truncated: false, omitted_matches: 5, start_index: 0, total_matches: 25, next_index: 20, has_more: true });
  });

  it('fails closed when multiple pages are present', async () => {
    const { reader } = setup([page, { ...page, id: 'page-target-2', url: 'https://example.com/other' }]);
    await reader.rememberPrepared(4200);
    await expect(reader.bind('native-target', 'native-tab', 4200, page.url)).rejects.toThrow('Ambiguous');
  });

  it('rejects a changed PID/profile/listener identity before reading', async () => {
    const test = setup();
    await test.reader.rememberPrepared(4200);
    await test.reader.bind('native-target', 'native-tab', 4200, page.url);
    test.changeIdentity({ ...initial, created: '2026-10-08T10:01:00.000Z' });
    await expect(test.reader.read('native-target', 'native-tab', 'h1')).rejects.toThrow('changed');
    expect(test.boundary.read).not.toHaveBeenCalled();
  });

  it('rejects unbound or cleared handles and oversized selectors', async () => {
    const { reader } = setup();
    await expect(reader.read('unknown', 'tab', 'h1')).rejects.toThrow('Stale');
    await reader.rememberPrepared(4200);
    await reader.bind('native-target', 'native-tab', 4200, page.url);
    await expect(reader.read('native-target', 'native-tab', 'x'.repeat(257))).rejects.toThrow('too long');
    reader.clear();
    await expect(reader.read('native-target', 'native-tab', 'h1')).rejects.toThrow('Stale');
  });

  it('rejects navigation changes during the read', async () => {
    const mutable = setup();
    await mutable.reader.rememberPrepared(4200);
    await mutable.reader.bind('native-target', 'native-tab', 4200, page.url);
    mutable.boundary.pages.mockResolvedValueOnce([page]).mockResolvedValueOnce([{ ...page, url: 'https://example.com/changed' }]);
    await expect(mutable.reader.read('native-target', 'native-tab', 'h1')).rejects.toThrow('changed during');
  });

  it('keeps the original CDP page identity across native URL refreshes', async () => {
    const test = setup();
    await test.reader.rememberPrepared(4200);
    await test.reader.bind('native-target', 'native-tab', 4200, page.url);
    test.boundary.pages.mockResolvedValue([{ ...page, url: 'https://example.com/next' }]);
    await test.reader.bind('native-target', 'native-tab', 4200, 'https://example.com/next');
    await expect(test.reader.bind('native-target', 'native-tab', 4200, 'https://example.com/next')).resolves.toBeUndefined();
    test.boundary.pages.mockResolvedValue([{ ...page, id: 'replacement-page', url: 'https://example.com/next', webSocketDebuggerUrl: 'ws://127.0.0.1:51000/devtools/page/replacement-page' }]);
    await expect(test.reader.bind('native-target', 'native-tab', 4200, 'https://example.com/next')).rejects.toThrow('identity changed');
  });

  it('allows initial about:blank binding but never reads it', async () => {
    const blank = { ...page, url: 'about:blank' };
    const test = setup([blank]);
    await test.reader.rememberPrepared(4200);
    await test.reader.bind('native-target', 'native-tab', 4200, 'about:blank');
    await expect(test.reader.read('native-target', 'native-tab', 'body')).rejects.toThrow('http(s)');
  });

  it('rejects foreign websocket hosts, credentials, and page paths before opening a socket', async () => {
    for (const webSocketDebuggerUrl of [
      'ws://example.com:51000/devtools/page/page-target-1',
      'ws://user:pass@127.0.0.1:51000/devtools/page/page-target-1',
      'ws://127.0.0.1:51000/devtools/page/other-page',
    ]) {
      const test = setup([{ ...page, webSocketDebuggerUrl }]);
      await test.reader.rememberPrepared(4200);
      await expect(test.reader.bind('native-target', 'native-tab', 4200, page.url)).rejects.toThrow('websocket endpoint');
      expect(test.boundary.read).not.toHaveBeenCalled();
    }
  });

  it('paginates matched records using start_index', async () => {
    const test = setup();
    await test.reader.rememberPrepared(4200);
    await test.reader.bind('native-target', 'native-tab', 4200, page.url);
    const first = await test.reader.read('native-target', 'native-tab', 'article');
    const next = await test.reader.read('native-target', 'native-tab', 'article', undefined, first.details.next_index);
    expect(first.details).toMatchObject({ start_index: 0, total_matches: 25, next_index: 20, has_more: true });
    expect(next.content[0]?.text).toContain('Product 20');
    expect(next.details).toMatchObject({ start_index: 20, next_index: 25, has_more: false, omitted_matches: 0 });
  });

  it('does not restore state or return data when clear races with async work', async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => { resolve = done; });
      return { promise, resolve };
    };

    const remembering = setup();
    const captureWait = deferred<typeof initial>();
    remembering.boundary.capture.mockReturnValueOnce(captureWait.promise);
    const remember = remembering.reader.rememberPrepared(4200);
    remembering.reader.clear();
    captureWait.resolve({ ...initial });
    await expect(remember).rejects.toThrow('session cleared');

    const binding = setup();
    await binding.reader.rememberPrepared(4200);
    const pagesWait = deferred<typeof page[]>();
    binding.boundary.pages.mockReturnValueOnce(pagesWait.promise);
    const bind = binding.reader.bind('native-target', 'native-tab', 4200, page.url);
    binding.reader.clear();
    pagesWait.resolve([page]);
    await expect(bind).rejects.toThrow('session cleared');

    const reading = setup();
    await reading.reader.rememberPrepared(4200);
    await reading.reader.bind('native-target', 'native-tab', 4200, page.url);
    const readWait = deferred<string>();
    reading.boundary.read.mockReturnValueOnce(readWait.promise);
    const read = reading.reader.read('native-target', 'native-tab', 'h1');
    await vi.waitFor(() => expect(reading.boundary.read).toHaveBeenCalled());
    reading.reader.clear();
    readWait.resolve(JSON.stringify({ matches: [], start_index: 0, total_matches: 0, omitted_matches: 0, next_index: 0, has_more: false, truncated: false }));
    await expect(read).rejects.toThrow('session cleared');
  });

  it('uses only the fixed read-only CDP methods and returns bounded allowed attributes', async () => {
    const sentMethods: string[] = [];
    const sockets: Array<{ closed: boolean }> = [];
    class FakeWebSocket extends EventTarget {
      closed = false;
      constructor() {
        super(); sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send(raw: string) {
        const request = JSON.parse(raw) as { id: number; method: string };
        sentMethods.push(request.method);
        const result = request.method === 'DOM.getDocument'
          ? { root: { nodeId: 1 } }
          : request.method === 'DOM.querySelectorAll'
            ? { nodeIds: [2] }
            : { node: { nodeType: 1, nodeName: 'H1', attributes: ['id', 'product-title', 'class', 'heading', 'title', 'x'.repeat(1000), 'value', 'secret'], children: [{ nodeType: 3, nodeName: '#text', nodeValue: 'Product title' }] } };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result }) })));
      }
      close() { this.closed = true; }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    try {
      const reader = new OwnedBrowserDomReader({ capture: async () => ({ ...initial }), pages: async () => [page] });
      await reader.rememberPrepared(4200);
      await reader.bind('native-target', 'native-tab', 4200, page.url);
      const result = await reader.read('native-target', 'native-tab', 'h1');
      const text = result.content[0]?.text ?? '';
      expect(sentMethods).toEqual(['DOM.getDocument', 'DOM.querySelectorAll', 'DOM.describeNode']);
      expect(text).toContain('product-title');
      expect(text).toContain('heading');
      expect(text).not.toContain('secret');
      expect(text).toContain('"truncated":true');
      expect(sockets.every((socket) => socket.closed)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
