import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from '@earendil-works/pi-coding-agent';

const MAX_RESULT_BYTES = DEFAULT_MAX_BYTES - 2 * 1024;
const MAX_DETAILS_BYTES = 18 * 1024;
const SERIALIZATION_OVERHEAD_BYTES = 1_024;

export interface McpContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content?: McpContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type PiToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function fitSerializedString(value: string, maxBytes: number, maxLines: number): string {
  let rawBudget = Math.max(0, maxBytes);
  while (rawBudget > 0) {
    const candidate = truncateHead(value, { maxBytes: rawBudget, maxLines }).content;
    if (byteLength(candidate) <= maxBytes) return candidate;
    rawBudget = Math.floor(rawBudget * 0.75);
  }
  return '';
}

export function boundStructuredContent(
  structuredContent: Record<string, unknown> | undefined,
  maxBytes = MAX_DETAILS_BYTES,
): Record<string, unknown> | undefined {
  if (!structuredContent || byteLength(structuredContent) <= maxBytes) {
    return structuredContent;
  }

  const bounded: Record<string, unknown> = { ...structuredContent, truncated: true };
  if (typeof bounded.tree_markdown === 'string') {
    delete bounded.tree_markdown;
    bounded.tree_markdown_omitted = true;
  }

  const elements = Array.isArray(bounded.elements) ? bounded.elements : undefined;
  if (elements) {
    bounded.total_elements = elements.length;
    let keep = elements.length;
    while (keep > 0 && byteLength({ ...bounded, elements: elements.slice(0, keep) }) > maxBytes) {
      keep = Math.floor(keep / 2);
    }
    bounded.elements = elements.slice(0, keep);
  }

  if (byteLength(bounded) <= maxBytes) return bounded;

  if (maxBytes <= 512) {
    return { truncated: true, original_bytes: byteLength(structuredContent) };
  }

  const serialized = JSON.stringify(structuredContent, null, 2);
  let previewBudget = maxBytes - 512;
  while (previewBudget > 0) {
    const preview = fitSerializedString(serialized, previewBudget, DEFAULT_MAX_LINES);
    const candidate = {
      truncated: true,
      original_bytes: byteLength(structuredContent),
      preview,
    };
    if (byteLength(candidate) <= maxBytes) return candidate;
    previewBudget = Math.floor(previewBudget * 0.75);
  }
  return { truncated: true, original_bytes: byteLength(structuredContent) };
}

export function toPiToolResult(
  result: McpToolResult,
  toolName?: string,
): {
  content: PiToolContent[];
  details: Record<string, unknown> | undefined;
  isError?: boolean;
} {
  const content: PiToolContent[] = [];
  const details = boundStructuredContent(result.structuredContent);
  const enrichment = fitSerializedString(
    toolName ? (buildEnrichment(toolName, result) ?? '') : '',
    toolName === 'get_browser_state' ? BROWSER_MAX_BYTES : ENRICHMENT_MAX_BYTES,
    toolName === 'get_browser_state' ? BROWSER_MAX_LINES : ENRICHMENT_MAX_LINES,
  );
  const enrichmentBytes = enrichment ? byteLength(enrichment) : 0;
  let remainingBytes = Math.max(
    0,
    MAX_RESULT_BYTES - byteLength(details) - SERIALIZATION_OVERHEAD_BYTES - enrichmentBytes,
  );
  let remainingLines = DEFAULT_MAX_LINES - (enrichment ? enrichment.split('\n').length : 0);

  for (const item of result.content ?? []) {
    if (item.type === 'image' && item.data) {
      // Keep image blocks valid; Pi's image pipeline applies its own decode/resize
      // limits, while this budget covers the text + details context payload.
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType ?? 'image/png' });
      continue;
    }
    if (item.type !== 'text' || !item.text || remainingBytes <= 0 || remainingLines <= 0) continue;

    const initial = truncateHead(item.text, {
      maxBytes: remainingBytes,
      maxLines: remainingLines,
    });
    const needsTruncation = initial.truncated || byteLength(initial.content) > remainingBytes;
    const noticeCandidate = needsTruncation
      ? `\n\n[pi-computer-use truncated output: ${initial.totalBytes} bytes, ${initial.totalLines} lines]`
      : '';
    const notice = byteLength(noticeCandidate) <= remainingBytes ? noticeCandidate : '';
    const textBudget = Math.max(0, remainingBytes - byteLength(notice));
    const text = `${fitSerializedString(
      item.text,
      textBudget,
      Math.max(1, remainingLines - (notice ? 2 : 0)),
    )}${notice}`;
    if (!text) continue;
    content.push({ type: 'text', text });
    remainingBytes -= byteLength(text);
    remainingLines -= text.split('\n').length;
  }

  if (enrichment) content.push({ type: 'text', text: enrichment });

  if (content.length === 0) content.push({ type: 'text', text: 'Action executed.' });

  return {
    content,
    details,
    ...(result.isError || result.structuredContent?.status === 'refused' ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Model-visible enrichment.
//
// Pi only sends `content` (text + images) to the LLM; `details`
// (structuredContent) is TUI-only. The cua-driver places several fields the
// model needs to act — snapshot_id, list_windows records, degraded_reason —
// exclusively in structuredContent, so they are rendered into bounded text
// here. Enrichment is idempotent (skipped when the driver text already
// carries the field) and defensive (schema drift degrades to pass-through).
// ---------------------------------------------------------------------------

const ENRICHMENT_MAX_BYTES = 4 * 1024;
const ENRICHMENT_MAX_LINES = 60;
const BROWSER_MAX_BYTES = 20 * 1024;
const BROWSER_MAX_LINES = 200;
const LIST_WINDOWS_MAX_RECORDS = 20;
// Matches the tree-row format the cua-driver 0.28.x MCP text output emits
// ("- [N] <role> ..."). Undocumented upstream format; a false positive only
// suppresses the max_elements hint, which is safe by design.
const TREE_LINE = /^[ \t]*- \[\d+\]/m;

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      )
    : [];
}

function windowRank(window: Record<string, unknown>): number {
  return (window.is_on_screen === true ? 2 : 0) + (window.on_current_space === true ? 1 : 0);
}

function formatWindowRecord(window: Record<string, unknown>): string | undefined {
  const windowId = window.window_id;
  if (typeof windowId !== 'number' && typeof windowId !== 'string') return undefined;
  const pid = typeof window.pid === 'number' ? String(window.pid) : '?';
  const app = typeof window.app_name === 'string' ? window.app_name : '?';
  const title =
    typeof window.title === 'string' && window.title ? ` "${window.title.slice(0, 40)}"` : '';
  const bounds =
    typeof window.bounds === 'object' && window.bounds !== null
      ? (window.bounds as Record<string, unknown>)
      : undefined;
  const geometry =
    bounds &&
    typeof bounds.x === 'number' &&
    typeof bounds.y === 'number' &&
    typeof bounds.width === 'number' &&
    typeof bounds.height === 'number'
      ? ` @${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`
      : '';
  const flags = [
    window.is_on_screen ? 'on-screen' : 'off-screen',
    window.on_current_space === true
      ? 'current-space'
      : window.on_current_space === false
        ? 'other-space'
        : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return `window_id=${windowId} pid=${pid} ${app}${title}${geometry} ${flags}`.trim();
}

function buildEnrichment(toolName: string, result: McpToolResult): string | undefined {
  const sc = result.structuredContent;
  if (!sc || typeof sc !== 'object') return undefined;
  if (toolName === 'browser_prepare' || toolName === 'get_browser_state') {
    return buildBrowserEnrichment(toolName, sc);
  }
  const existingText = (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
  const parts: string[] = [];

  if (toolName === 'get_window_state') {
    const snapshotId = typeof sc.snapshot_id === 'string' ? sc.snapshot_id : undefined;
    if (snapshotId && !existingText.includes(`snapshot_id=${snapshotId}`)) {
      parts.push(`snapshot_id=${snapshotId} (pair with element_index for element addressing)`);
    }
    if (sc.degraded === true || typeof sc.degraded_reason === 'string') {
      const reason = typeof sc.degraded_reason === 'string' ? sc.degraded_reason : 'unknown';
      if (!existingText.includes(`degraded_reason=${reason}`)) {
        parts.push(
          `degraded_reason=${reason} - activate the window onto the current Space first (e.g. bring_to_front), then retry`,
        );
      }
    }
    const elementCount = typeof sc.element_count === 'number' ? sc.element_count : undefined;
    const elements = asRecordArray(sc.elements);
    if (
      !TREE_LINE.test(existingText) &&
      ((elementCount !== undefined && elementCount > 0) || elements.length > 0)
    ) {
      parts.push(
        'AX tree is not in the text above (large or TUI-only payload). Re-run get_window_state with max_elements:300-400 to include a bounded tree.',
      );
    }
  } else if (toolName === 'list_windows') {
    const windows = asRecordArray(sc.windows);
    if (windows.length > 0 && !existingText.includes('window_id=')) {
      const lines = windows
        .map((window, index) => ({ window, index }))
        .sort((a, b) => windowRank(b.window) - windowRank(a.window) || a.index - b.index)
        .slice(0, LIST_WINDOWS_MAX_RECORDS)
        .map(({ window }) => formatWindowRecord(window))
        .filter((line): line is string => line !== undefined);
      if (lines.length > 0) {
        parts.push(`window records (top ${lines.length} of ${windows.length}, on-screen first):`);
        parts.push(...lines);
      }
    }
  }

  return parts.length > 0 ? `[pi-computer-use model-visible]\n${parts.join('\n')}` : undefined;
}

function buildBrowserEnrichment(toolName: string, sc: Record<string, unknown>): string | undefined {
  const parts = ['[pi-computer-use browser addressing]'];
  const handles: Record<string, unknown> = {};
  for (const key of toolName === 'browser_prepare'
    ? ['prepared_pid']
    : ['target_id', 'tab_id', 'snapshot_id']) {
    const value = sc[key];
    if (
      key === 'prepared_pid'
        ? typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        : typeof value === 'string' && value.length > 0 && value.length <= 256
    ) {
      handles[key] = value;
    }
  }
  if (Object.keys(handles).length > 0) parts.push(JSON.stringify(handles));
  if (toolName === 'browser_prepare') return parts.length > 1 ? parts.join('\n') : undefined;
  const refusal = sc.refusal;
  if (
    toolName === 'get_browser_state' &&
    sc.status === 'refused' &&
    typeof refusal === 'object' &&
    refusal !== null &&
    (refusal as Record<string, unknown>).code === 'browser_ref_stale'
  ) {
    parts.push(
      'The browser rejected a stale ref or continuation. Take a fresh semantic_v2 snapshot with the same target_id and tab_id, omitting continuation, query, and scope_ref. Use refs and continuation values only from the latest returned observation; pass continuation only when that snapshot is incomplete.',
    );
  }

  const snapshot = sc.snapshot;
  if (snapshot && typeof snapshot === 'object') {
    const { complete, continuation } = snapshot as Record<string, unknown>;
    const metadata: Record<string, unknown> = {};
    if (typeof complete === 'boolean') metadata.complete = complete;
    const scope = (snapshot as Record<string, unknown>).scope;
    if (typeof scope === 'string' && scope.length > 0 && scope.length <= 64) {
      metadata.scope = scope;
    }
    for (const key of ['selected_nodes', 'total_nodes'] as const) {
      const value = (snapshot as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        metadata[key] = value;
      }
    }
    if (Object.keys(metadata).length > 0) parts.push(JSON.stringify(metadata));
    if (typeof continuation === 'string' && continuation.length <= 512) {
      parts.push(JSON.stringify({ continuation }));
    }
  }

  // Preserve complete addressing records; a truncated opaque ref cannot be used.
  for (const [key, idKey] of [
    ['tabs', 'tab_id'],
    ['refs', 'ref'],
    ['content_refs', 'ref'],
  ] as const) {
    const records = asRecordArray(sc[key]);
    const emptyStructural = (record: Record<string, unknown>) =>
      key === 'content_refs' &&
      (record.role === 'generic' || record.role === 'paragraph') &&
      !['name', 'label', 'value', 'text'].some(
        (field) => typeof record[field] === 'string' && (record[field] as string).trim().length > 0,
      ) &&
      !(
        Array.isArray(record.actions) &&
        record.actions.some((action) => typeof action === 'string' && action.trim().length > 0)
      );
    const omittedEmpty = records.filter(emptyStructural).length;
    const candidates = records.filter((record) => !emptyStructural(record));
    const contentDefaults: Record<string, unknown> = {};
    if (key === 'content_refs' && candidates.length >= 3) {
      if (candidates.every((record) => record.frame === 'main')) contentDefaults.frame = 'main';
      if (
        candidates.every((record) => Array.isArray(record.actions) && record.actions.length === 0)
      ) {
        contentDefaults.actions = [];
      }
      if (Object.keys(contentDefaults).length > 0) {
        parts.push(`Content ref defaults: ${JSON.stringify(contentDefaults)}`);
      }
    }
    const contentPriority = (record: Record<string, unknown>) => {
      const hasReadableText = ['name', 'label'].some(
        (field) => typeof record[field] === 'string' && (record[field] as string).trim().length > 0,
      );
      const role = record.role;
      if (role === 'listmarker') {
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        return /^\d+[.)]?$/.test(name) ? 2 : 5;
      }
      if (hasReadableText) return 0;
      if (
        Array.isArray(record.actions) &&
        record.actions.some((action) => typeof action === 'string' && action.trim().length > 0)
      ) {
        return 3;
      }
      return 4;
    };
    // Put editable controls before decorative clickable images on crowded pages.
    const ranked =
      key === 'refs'
        ? [...candidates].sort(
            (a, b) =>
              Number(Array.isArray(b.actions) && b.actions.includes('type')) * 2 +
              Number(typeof b.name === 'string' && b.name.length > 0) -
              (Number(Array.isArray(a.actions) && a.actions.includes('type')) * 2 +
                Number(typeof a.name === 'string' && a.name.length > 0)),
          )
        : key === 'content_refs'
          ? candidates
              .map((record, index) => ({ record, index }))
              .sort(
                (a, b) =>
                  contentPriority(a.record) - contentPriority(b.record) || a.index - b.index,
              )
              .map(({ record }) => record)
          : candidates;
    let shown = 0;
    for (const record of ranked) {
      const id = record[idKey];
      if (typeof id !== 'string' || !id || id.length > 256) continue;
      const visible: Record<string, unknown> = { [idKey]: id };
      const truncatedFields: string[] = [];
      for (const field of ['title', 'frame', 'role', 'name', 'node', 'label', 'visibility']) {
        if (key === 'content_refs' && field === 'frame' && 'frame' in contentDefaults) continue;
        if (typeof record[field] === 'string') {
          visible[field] = record[field].slice(0, 160);
          if (record[field].length > 160) truncatedFields.push(field);
        }
      }
      if (truncatedFields.length > 0) visible.truncated_fields = truncatedFields;
      if (Array.isArray(record.actions)) {
        if (!(key === 'content_refs' && 'actions' in contentDefaults)) {
          visible.actions = record.actions
            .filter((action) => typeof action === 'string' && action.length <= 40)
            .slice(0, 10);
        }
      }
      if (typeof record.active === 'boolean') visible.active = record.active;
      const line = JSON.stringify(visible);
      const byteBudget = key === 'content_refs' ? BROWSER_MAX_BYTES - 2048 : 4096;
      if (
        parts.length >= BROWSER_MAX_LINES - 30 ||
        byteLength([...parts, line].join('\n')) > byteBudget
      ) {
        break;
      }
      parts.push(line);
      shown++;
    }
    if (records.length > 0) {
      const omitted =
        omittedEmpty > 0 ? `; ${omittedEmpty} empty generic/paragraph refs omitted` : '';
      parts.push(`${key}: ${shown} of ${records.length} records shown${omitted}`);
    }
  }
  if (typeof sc.outline === 'string' && parts.length < BROWSER_MAX_LINES - 1) {
    const outline = fitSerializedString(
      sc.outline
        .split('\n')
        .filter((line) => !/^\s*- (generic|paragraph)\s*$/.test(line))
        .join('\n'),
      Math.max(0, BROWSER_MAX_BYTES - byteLength(parts.join('\n')) - 32),
      BROWSER_MAX_LINES - parts.length - 1,
    );
    if (outline) parts.push(`Page outline:\n${outline}`);
  }
  return parts.length > 1 ? parts.join('\n') : undefined;
}
