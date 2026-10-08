import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { request } from 'node:http';

const execFileAsync = promisify(execFile);
const MAX_SELECTOR_LENGTH = 256;
const MAX_MATCHES = 20;
const MAX_TEXT_BYTES = 12_000;
const MAX_CDP_BYTES = 1_000_000;
const MAX_ATTRIBUTE_LENGTH = 256;
const ATTRIBUTES = ['href', 'title', 'aria-label', 'role', 'alt', 'id', 'class'] as const;

type ProcessIdentity = { pid: number; created: string; commandLine: string };
type ListenerIdentity = { pid: number; port: number; activePort: string };
type Page = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
type CdpNode = {
  nodeType?: number;
  nodeName?: string;
  nodeValue?: string;
  children?: CdpNode[];
  attributes?: string[];
};

type OwnedProcess = ProcessIdentity & {
  profile: string;
  port: number;
  activePort: string;
};

type NativePage = Page & { selector?: string; startIndex?: number };
type NativeBoundary = {
  capture(pid: number, signal?: AbortSignal): Promise<OwnedProcess>;
  pages(port: number, signal?: AbortSignal): Promise<Page[]>;
  read?(page: NativePage, port: number, signal?: AbortSignal): Promise<string>;
};

type Binding = {
  pid: number;
  targetId: string;
  tabId: string;
  pageId: string;
  url: string;
};

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
}

async function powershell(script: string, signal?: AbortSignal): Promise<string> {
  abortIfNeeded(signal);
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 32_768, windowsHide: true, signal },
  );
  return stdout.trim();
}

async function processIdentity(pid: number, signal?: AbortSignal): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned browser process');
  const raw = await powershell(
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){[pscustomobject]@{pid=$p.ProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o');commandLine=$p.CommandLine}|ConvertTo-Json -Compress}`,
    signal,
  );
  const value = JSON.parse(raw) as Partial<ProcessIdentity>;
  if (value.pid !== pid || typeof value.created !== 'string' || typeof value.commandLine !== 'string') {
    throw new Error('Owned browser process identity unavailable');
  }
  return { pid, created: value.created, commandLine: value.commandLine };
}

function profileFromCommandLine(commandLine: string): string {
  const match = commandLine.match(/(?:^|\s)--user-data-dir=(?:"([^"]+)"|([^\s]+))/i);
  const profile = match?.[1] ?? match?.[2];
  if (!profile) throw new Error('Owned isolated profile unavailable');
  return profile;
}

async function listenerIdentity(pid: number, profile: string, signal?: AbortSignal): Promise<ListenerIdentity> {
  const activePort = await readFile(`${profile}/DevToolsActivePort`, 'utf8');
  const [portText, browserPath] = activePort.trim().split(/\r?\n/);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath?.startsWith('/devtools/browser/')) {
    throw new Error('Owned CDP endpoint unavailable');
  }
  const raw = await powershell(
    `@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess) -join ','`,
    signal,
  );
  const owners = [...new Set(raw.split(',').filter(Boolean).map(Number))];
  if (owners.length !== 1 || owners[0] !== pid) throw new Error('Owned CDP listener mismatch');
  return { pid, port, activePort };
}

async function capture(pid: number, signal?: AbortSignal): Promise<OwnedProcess> {
  const identity = await processIdentity(pid, signal);
  if (identity.pid !== pid) throw new Error('Owned browser PID mismatch');
  const profile = await realpath(profileFromCommandLine(identity.commandLine));
  if (!profile || profile === '/' || /^[A-Za-z]:\\?$/i.test(profile)) throw new Error('Unsafe isolated profile identity');
  const listener = await listenerIdentity(pid, profile, signal);
  return { ...identity, profile, port: listener.port, activePort: listener.activePort };
}

async function jsonRequest(url: string, signal?: AbortSignal): Promise<unknown> {
  abortIfNeeded(signal);
  return await new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', signal, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_CDP_BYTES) {
          req.destroy(new Error('CDP response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('CDP endpoint unavailable');
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('CDP request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function getPages(port: number, signal?: AbortSignal): Promise<Page[]> {
  const value = await jsonRequest(`http://127.0.0.1:${port}/json/list`, signal);
  if (!Array.isArray(value)) throw new Error('Invalid CDP page list');
  return value.filter((entry): entry is Page => {
    if (!entry || typeof entry !== 'object') return false;
    const page = entry as Partial<Page>;
    return page.type === 'page';
  });
}

function readSocket(page: NativePage, port: number, signal?: AbortSignal): Promise<string> {
  const endpoint = checkedWebSocket(page, port);
  abortIfNeeded(signal);
  const WebSocketConstructor = (globalThis as typeof globalThis & { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketConstructor) throw new Error('WebSocket support unavailable');

  return new Promise((resolve, reject) => {
    const socket = new WebSocketConstructor(endpoint);
    let sequence = 0;
    let settled = false;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      for (const entry of pending.values()) entry.reject(new Error('CDP connection closed'));
      pending.clear();
      socket.close();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const timer = setTimeout(() => fail(new Error('CDP read timed out')), 15000);
    const abort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    const onError = () => fail(new Error('CDP connection failed'));
    const onClose = () => fail(new Error('CDP connection closed'));
    const onMessage = (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (Buffer.byteLength(raw) > MAX_CDP_BYTES) { fail(new Error('CDP response too large')); return; }
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(raw) as typeof message; } catch { fail(new Error('Invalid CDP response')); return; }
      if (message.id === undefined) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message ?? 'CDP command failed')) : entry.resolve(message.result);
    };
    const onOpen = async () => {
      try {
        const call = (method: 'DOM.getDocument' | 'DOM.querySelectorAll' | 'DOM.describeNode', params: Record<string, unknown> = {}) =>
          new Promise<unknown>((res, rej) => {
            const id = ++sequence;
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        const doc = await call('DOM.getDocument', { depth: 1 }) as { root?: { nodeId?: number } };
        if (!Number.isSafeInteger(doc.root?.nodeId)) throw new Error('Invalid DOM root');
        const found = await call('DOM.querySelectorAll', { nodeId: doc.root!.nodeId, selector: page.selector }) as { nodeIds?: number[] };
        const nodeIds = found.nodeIds;
        if (!Array.isArray(nodeIds)) throw new Error('Invalid DOM matches');
        const requestedStart = page.startIndex ?? 0;
        const startIndex = Math.min(requestedStart, nodeIds.length);
        const endIndex = Math.min(startIndex + MAX_MATCHES, 10_000, nodeIds.length);
        const records: Array<{ text: string; attributes: Record<string, string>; truncated?: boolean }> = [];
        for (const nodeId of nodeIds.slice(startIndex, endIndex)) {
          const described = await call('DOM.describeNode', { nodeId, depth: -1 }) as { node?: CdpNode };
          if (!described.node) throw new Error('Invalid DOM node response');
          const attrs = described.node.attributes ?? [];
          const attributes: Record<string, string> = {};
          let attributesTruncated = false;
          for (let i = 0; i + 1 < attrs.length; i += 2) {
            if ((ATTRIBUTES as readonly string[]).includes(attrs[i]!)) {
              const value = attrs[i + 1]!;
              attributes[attrs[i]!] = value.slice(0, MAX_ATTRIBUTE_LENGTH);
              attributesTruncated ||= value.length > MAX_ATTRIBUTE_LENGTH;
            }
          }
          const collect = (node: CdpNode): string => {
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'SELECT'].includes((node.nodeName ?? '').toUpperCase())) return '';
            if (node.nodeType === 3) return node.nodeValue ?? '';
            return (node.children ?? []).map(collect).filter(Boolean).join(' ');
          };
          const textValue = collect(described.node).replace(/\s+/g, ' ').trim();
          records.push({ text: textValue.slice(0, 6000), attributes, ...(attributesTruncated || textValue.length > 6000 ? { truncated: true } : {}) });
        }
        const payload: { matches: typeof records; start_index: number; total_matches: number; omitted_matches: number; next_index: number; has_more: boolean; truncated?: boolean } = {
          matches: records,
          start_index: startIndex,
          total_matches: nodeIds.length,
          omitted_matches: Math.max(0, nodeIds.length - startIndex - records.length),
          next_index: startIndex + records.length,
          has_more: startIndex + records.length < Math.min(nodeIds.length, 10_000),
        };
        payload.truncated = records.some((record) => 'truncated' in record);
        let text = JSON.stringify(payload);
        let truncated = false;
        if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
          truncated = true;
          payload.truncated = true;
          text = JSON.stringify(payload);
        }
        while (Buffer.byteLength(text) > MAX_TEXT_BYTES && records.length) {
          truncated = true;
          const last = records.at(-1)!;
          if (last.text) last.text = last.text.slice(0, Math.max(0, last.text.length - 256));
          else records.pop();
          payload.omitted_matches = Math.max(0, nodeIds.length - startIndex - records.length);
          payload.next_index = startIndex + records.length;
          payload.has_more = payload.next_index < Math.min(nodeIds.length, 10_000);
          text = JSON.stringify(payload);
        }
        if (truncated) payload.truncated = true;
        succeed(JSON.stringify(payload));
      } catch (error) {
        fail(error instanceof Error ? error : new Error('CDP read failed'));
      }
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function checkedWebSocket(page: Page, port: number): URL {
  const endpoint = new URL(page.webSocketDebuggerUrl);
  if (
    endpoint.protocol !== 'ws:' ||
    !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    Number(endpoint.port) !== port ||
    endpoint.pathname !== `/devtools/page/${page.id}`
  ) throw new Error('Unowned CDP websocket endpoint');
  return endpoint;
}

/** Reads bounded DOM content from a browser process owned by this extension session. */
export class OwnedBrowserDomReader {
  private readonly owned = new Map<number, OwnedProcess>();
  private readonly bindings = new Map<string, Binding>();
  private generation = 0;

  constructor(private readonly native: NativeBoundary = { capture, pages: getPages, read: readSocket }) {}

  async rememberPrepared(pid: number, signal?: AbortSignal): Promise<void> {
    const generation = this.generation;
    const owner = await this.native.capture(pid, signal);
    this.assertGeneration(generation);
    if (owner.pid !== pid) throw new Error('Owned browser PID mismatch');
    this.owned.set(pid, owner);
  }

  async bind(targetId: string, tabId: string, pid: number, url: string, signal?: AbortSignal): Promise<void> {
    const generation = this.generation;
    const owner = this.owned.get(pid);
    if (!owner || !targetId || !tabId || !url) throw new Error('Browser is not eligible for DOM reading');
    await this.recheck(owner, signal);
    this.assertGeneration(generation);
    const found = await this.native.pages(owner.port, signal);
    this.assertGeneration(generation);
    if (this.owned.get(pid) !== owner) throw new Error('Stale browser ownership');
    const matching = found.filter((page) => page.url === url);
    if (matching.length !== 1 || found.length !== 1) throw new Error('Ambiguous owned browser page');
    const page = matching[0]!;
    checkedWebSocket(page, owner.port);
    const key = `${targetId}\0${tabId}`;
    const prior = this.bindings.get(key);
    if (prior && (prior.pid !== pid || prior.pageId !== page.id)) throw new Error('CDP page identity changed');
    this.bindings.set(key, { pid, targetId, tabId, pageId: page.id, url });
  }

  async read(targetId: string, tabId: string, selector: string, signal?: AbortSignal, startIndex = 0): Promise<{ content: Array<{ type: 'text'; text: string }>; details: { truncated: boolean; omitted_matches: number; start_index: number; total_matches: number; next_index: number; has_more: boolean } }> {
    const generation = this.generation;
    if (typeof selector !== 'string' || selector.length < 1 || selector.length > MAX_SELECTOR_LENGTH) throw new Error('Selector is empty or too long');
    if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex > 10_000) throw new Error('start_index is out of range');
    const binding = this.bindings.get(`${targetId}\0${tabId}`);
    const owner = binding && this.owned.get(binding.pid);
    if (!binding || !owner) throw new Error('Stale or unowned browser binding');
    if (!/^https?:\/\//i.test(binding.url)) throw new Error('DOM reading requires an http(s) page');
    await this.recheck(owner, signal);
    this.assertGeneration(generation);
    const current = await this.native.pages(owner.port, signal);
    this.assertGeneration(generation);
    if (current.length !== 1 || current[0]?.id !== binding.pageId || current[0]?.url !== binding.url) throw new Error('Stale or ambiguous browser page');
    checkedWebSocket(current[0], owner.port);
    const page = { ...current[0], selector, ...(startIndex === 0 ? {} : { startIndex }) };
    const raw = await (this.native.read ?? readSocket)(page, owner.port, signal);
    this.assertGeneration(generation);
    await this.recheck(owner, signal);
    this.assertGeneration(generation);
    const after = await this.native.pages(owner.port, signal);
    this.assertGeneration(generation);
    if (after.length !== 1 || after[0]?.id !== binding.pageId || after[0]?.url !== binding.url) throw new Error('Browser page changed during DOM read');
    const result = JSON.parse(raw) as {
      omitted_matches: number;
      start_index: number;
      total_matches: number;
      next_index: number;
      has_more: boolean;
      truncated?: boolean;
    };
    return {
      content: [{ type: 'text', text: raw }],
      details: {
        truncated: result.truncated === true,
        omitted_matches: result.omitted_matches,
        start_index: result.start_index,
        total_matches: result.total_matches,
        next_index: result.next_index,
        has_more: result.has_more,
      },
    };
  }

  clear(): void {
    this.generation += 1;
    this.owned.clear();
    this.bindings.clear();
  }

  private assertGeneration(expected: number): void {
    if (this.generation !== expected) throw new Error('Browser session cleared');
  }

  private async recheck(owner: OwnedProcess, signal?: AbortSignal): Promise<void> {
    const current = await this.native.capture(owner.pid, signal);
    if (current.pid !== owner.pid) throw new Error('Owned browser PID mismatch');
    if (
      current.created !== owner.created ||
      current.commandLine !== owner.commandLine ||
      current.profile !== owner.profile ||
      current.port !== owner.port ||
      current.activePort !== owner.activePort
    ) throw new Error('Owned browser process or CDP endpoint changed');
  }
}
