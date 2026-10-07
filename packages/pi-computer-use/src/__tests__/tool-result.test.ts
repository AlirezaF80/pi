import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { toPiToolResult } from '../tool-result.js';

describe('toPiToolResult', () => {
  it('preserves text-only results when structured content is absent', () => {
    expect(
      toPiToolResult({ content: [{ type: 'text', text: 'Action executed with details.' }] })
        .content,
    ).toEqual([{ type: 'text', text: 'Action executed with details.' }]);
  });

  it('bounds text and structured elements without dropping image content', () => {
    const result = toPiToolResult({
      content: [
        { type: 'image', data: 'image-base64', mimeType: 'image/png' },
        { type: 'text', text: `${'tree row\n'.repeat(8_000)}` },
      ],
      structuredContent: {
        tree_markdown: 'tree row\n'.repeat(8_000),
        elements: Array.from({ length: 4_000 }, (_, index) => ({
          element_index: index,
          element_token: `token-${index}`,
          label: 'x'.repeat(40),
        })),
      },
    });

    expect(result.content[0]).toEqual({
      type: 'image',
      data: 'image-base64',
      mimeType: 'image/png',
    });
    expect(result.content[1]?.type).toBe('text');
    expect((result.content[1] as { text: string }).text).toContain('truncated output');
    expect(result.details?.truncated).toBe(true);
    const boundedPayload = {
      content: result.content.filter((item) => item.type === 'text'),
      details: result.details,
    };
    expect(Buffer.byteLength(JSON.stringify(boundedPayload), 'utf8')).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
    );
  });

  describe('model-visible enrichment', () => {
    it('preserves snapshot addressing within the total line budget', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: Array(2000).fill('row').join('\n') }],
          structuredContent: { snapshot_id: 's00000001' },
        },
        'get_window_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
      expect(text).toContain('snapshot_id=s00000001');
      expect(text).toContain('truncated output');
    });

    it('appends snapshot_id for get_window_state when the driver text lacks it', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'window_id=8419 pid=47184 elements=2\n' }],
          structuredContent: { snapshot_id: 's0000000d', element_count: 2 },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('snapshot_id=s0000000d');
    });

    it('exposes validated browser snapshot scope and node counts', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Two matching nodes.' }],
          structuredContent: {
            snapshot: {
              complete: true,
              scope: 'query',
              selected_nodes: 2,
              total_nodes: 2,
            },
          },
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain(
        '{"complete":true,"scope":"query","selected_nodes":2,"total_nodes":2}',
      );

      const invalid = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Snapshot.' }],
          structuredContent: {
            snapshot: {
              complete: 'yes',
              scope: 'x'.repeat(1000),
              selected_nodes: -1,
              total_nodes: Number.MAX_SAFE_INTEGER + 1,
            },
          },
        },
        'get_browser_state',
      );
      const invalidText = invalid.content
        .map((item) => ('text' in item ? item.text : ''))
        .join('\n');
      expect(invalidText).not.toContain('selected_nodes');
      expect(invalidText).not.toContain('total_nodes');
      expect(invalidText).not.toContain('"scope"');
      expect(invalidText).not.toContain('"complete"');
    });

    it('adds recovery guidance only for stale browser snapshot refs', () => {
      const stale = toPiToolResult(
        {
          content: [{ type: 'text', text: 'refused (browser_ref_stale): stale continuation.' }],
          structuredContent: {
            status: 'refused',
            refusal: { code: 'browser_ref_stale', message: 'stale continuation' },
          },
          isError: true,
        },
        'get_browser_state',
      );
      const staleText = stale.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(stale.isError).toBe(true);
      expect(staleText).toContain('refused (browser_ref_stale): stale continuation.');
      expect(staleText).toContain('fresh semantic_v2 snapshot');
      expect(staleText).toContain('same target_id and tab_id');
      expect(staleText).toContain('omitting continuation, query, and scope_ref');
      expect(staleText).toContain('latest returned observation');

      const unrelated = toPiToolResult(
        {
          content: [
            { type: 'text', text: 'refused (browser_route_unavailable): route unavailable.' },
          ],
          structuredContent: {
            status: 'refused',
            refusal: { code: 'browser_route_unavailable', message: 'route unavailable' },
          },
          isError: true,
        },
        'get_browser_state',
      );
      const unrelatedText = unrelated.content
        .map((item) => ('text' in item ? item.text : ''))
        .join('\n');
      expect(unrelated.isError).toBe(true);
      expect(unrelatedText).not.toContain('fresh semantic_v2 snapshot');

      const otherTool = toPiToolResult(
        {
          content: [{ type: 'text', text: 'refused (browser_ref_stale): stale ref.' }],
          structuredContent: {
            status: 'refused',
            refusal: { code: 'browser_ref_stale', message: 'stale ref' },
          },
          isError: true,
        },
        'browser_click',
      );
      expect(
        otherTool.content.map((item) => ('text' in item ? item.text : '')).join('\n'),
      ).not.toContain('fresh semantic_v2 snapshot');
    });

    it('keeps late page context visible when empty structural refs crowd the snapshot', () => {
      const emptyRefs = Array.from({ length: 100 }, (_, index) => ({
        ref: `p8:${index}`,
        role: index % 2 === 0 ? 'generic' : 'paragraph',
        actions: [],
      }));
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Page snapshot.' }],
          structuredContent: {
            content_refs: [
              ...emptyRefs,
              { ref: 'p8:99a', role: 'generic', name: '  ', label: '\t' },
              { ref: 'p8:100', role: 'generic', name: 'Sample Author' },
              { ref: 'p8:101', role: 'generic', text: 'Visible review body' },
              { ref: 'p8:102', role: 'generic', actions: ['click'] },
              { ref: 'p8:103', role: 'heading' },
              { ref: 'p8:104', role: 'generic', value: '  Visible value  ' },
            ],
            outline: `Opening context ${'x'.repeat(3000)}\nReview by Sample Author: The item remained comfortable during extended use.`,
          },
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain(
        'Review by Sample Author: The item remained comfortable during extended use.',
      );
      expect(text).toContain('Sample Author');
      expect(text).toContain('p8:101');
      expect(text).toContain('p8:102');
      expect(text).toContain('p8:103');
      expect(text).toContain('p8:104');
      expect(text).toContain('101 empty generic/paragraph refs omitted');
      expect(text).toContain('5 of 106 records shown');
    });

    it('prioritizes readable content ahead of list structure and markers', () => {
      const records = [
        ...Array.from({ length: 70 }, (_, index) => ({
          ref: `p9:${index}`,
          role: 'listitem',
          actions: [],
        })),
        ...Array.from({ length: 70 }, (_, index) => ({
          ref: `p9:${index + 70}`,
          role: 'listmarker',
          name: '•',
          actions: [],
        })),
        { ref: 'p9:190', role: 'listmarker', name: '1.', actions: [] },
        { ref: 'p9:191', role: 'heading', name: 'Field notes', actions: [] },
        {
          ref: 'p9:192',
          role: 'statictext',
          name: 'A plain text body with useful nearby context.',
          actions: [],
        },
        {
          ref: 'p9:193',
          role: 'statictext',
          name: 'Author: Rowan Example. Label: field notes.',
          actions: [],
        },
        { ref: 'p9:194', role: 'heading', name: 'Workshop report', actions: [] },
        {
          ref: 'p9:195',
          role: 'statictext',
          name: 'A second body with a separate observation.',
          actions: [],
        },
      ];
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Snapshot contains the full selected node set.' }],
          structuredContent: {
            snapshot: { complete: true, scope: 'viewport', selected_nodes: 263, total_nodes: 263 },
            content_refs: records,
          },
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');

      expect(text).toContain('Field notes');
      expect(text).toContain('A plain text body with useful nearby context.');
      expect(text).toContain('Author: Rowan Example. Label: field notes.');
      expect(text).toContain('Workshop report');
      expect(text).toContain('p9:193');
      expect(text).toContain('content_refs:');
      expect(text).toMatch(/content_refs: \d+ of 146 records shown/);
      expect(result.details?.content_refs).toEqual(records);
    });

    it('retains numbered markers and unnamed actionable content when space permits', () => {
      const result = toPiToolResult(
        {
          structuredContent: {
            content_refs: [
              { ref: 'p1:1', role: 'listmarker', name: '1.', actions: [] },
              { ref: 'p1:2', role: 'button', actions: ['click'] },
              { ref: 'p1:3', role: 'statictext', name: 'Readable body', actions: [] },
            ],
          },
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain('p1:1');
      expect(text).toContain('p1:2');
      expect(text).toContain('Readable body');
      expect(text).toContain('3 of 3 records shown');
    });

    it('uses explicit uniform content-ref defaults to preserve late named content', () => {
      const records = Array.from({ length: 80 }, (_, index) => ({
        ref: `p2:${index + 1}`,
        role: 'statictext',
        name: `Neutral note ${index + 1} with repeated source text context abcdefghijklmnopqrstuvwxyz`,
        frame: 'main',
        actions: [] as string[],
      }));
      records[30]!.name = 'AI summary label';
      records[34]!.name = 'Field author Rowan Example';
      records[39]!.name = 'First neutral body';
      records[46]!.name = 'Workshop author Casey Example';
      records[51]!.name = 'Second neutral body';
      records[57]!.name = 'Reading author Morgan Example';
      records[62]!.name = 'Third neutral body';
      records[70]!.value = 'private typed value';
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Neutral page snapshot.' }],
          structuredContent: {
            target_id: 'target-neutral',
            tab_id: 'tab-neutral',
            snapshot: {
              complete: false,
              scope: 'viewport',
              selected_nodes: 80,
              total_nodes: 300,
              continuation: 'opaque-neutral-token',
            },
            refs: Array.from({ length: 20 }, (_, index) => ({
              ref: `action-${index + 1}`,
              role: 'button',
              name: `Continue action ${index + 1} ${'x'.repeat(100)}`,
              frame: 'main',
              visibility: 'visible',
              actions: ['click'],
            })),
            content_refs: records,
          },
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      for (const value of [
        'Field author Rowan Example',
        'First neutral body',
        'Workshop author Casey Example',
        'Second neutral body',
        'Reading author Morgan Example',
        'Third neutral body',
      ])
        expect(text).toContain(value);
      expect(text).toContain('Content ref defaults: {"frame":"main","actions":[]}');
      expect(text.indexOf('AI summary label')).toBeLessThan(
        text.indexOf('Field author Rowan Example'),
      );
      const visibleActionRecords = text
        .split('\n')
        .filter((line) => line.includes('"ref":"action-'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(visibleActionRecords.length).toBeGreaterThan(0);
      expect(visibleActionRecords.length).toBeLessThan(20);
      expect(
        visibleActionRecords.every(
          (record) =>
            record.role === 'button' &&
            record.frame === 'main' &&
            typeof record.name === 'string' &&
            record.visibility === 'visible' &&
            Array.isArray(record.actions) &&
            record.actions[0] === 'click',
        ),
      ).toBe(true);
      expect(text).toContain('"ref":"p2:80"');
      expect(text).toContain('target-neutral');
      expect(text).toContain('opaque-neutral-token');
      expect(text).toContain('"ref":"action-1"');
      expect(text).toContain('"name":"Continue action 1');
      expect(text).toContain('"frame":"main"');
      expect(text).toContain('"visibility":"visible"');
      expect(text).toContain('"actions":["click"]');
      expect(text).not.toContain('private typed value');
      expect(
        Buffer.byteLength(
          JSON.stringify({ content: result.content, details: result.details }),
          'utf8',
        ),
      ).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    });

    it('reports truthful shown and total counts for oversized compact content refs', () => {
      const records = Array.from({ length: 280 }, (_, index) => ({
        ref: `p3:${index + 1}`,
        role: 'statictext',
        name: `Long neutral content record ${index + 1} ${'context '.repeat(12)}`,
        frame: 'main',
        actions: [],
      }));
      const result = toPiToolResult(
        { content: [], structuredContent: { content_refs: records } },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      const count = text.match(/content_refs: (\d+) of 280 records shown/);
      expect(count).not.toBeNull();
      expect(Number(count?.[1])).toBeGreaterThan(0);
      expect(Number(count?.[1])).toBeLessThan(280);
      expect(text).toContain('"ref":"p3:1"');
      expect(text).not.toContain('"ref":"p3:280"');
      expect(
        Buffer.byteLength(
          JSON.stringify({ content: result.content, details: result.details }),
          'utf8',
        ),
      ).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    });

    it('keeps per-record fields when content-ref defaults are not uniform', () => {
      const mixedFrames = toPiToolResult(
        {
          content: [],
          structuredContent: {
            content_refs: [
              { ref: 'p1:1', role: 'text', name: 'First', frame: 'main', actions: [] },
              { ref: 'p1:2', role: 'text', name: 'Second', frame: 'child', actions: [] },
              { ref: 'p1:3', role: 'text', name: 'Third', actions: [] },
            ],
          },
        },
        'get_browser_state',
      );
      const mixedFrameText = mixedFrames.content
        .map((item) => ('text' in item ? item.text : ''))
        .join('\n');
      expect(mixedFrameText).toContain('Content ref defaults: {"actions":[]}');
      expect(mixedFrameText).toContain('"frame":"main"');
      expect(mixedFrameText).toContain('"frame":"child"');
      expect(mixedFrameText.match(/"actions"/g)?.length).toBe(1);

      const mixedActions = toPiToolResult(
        {
          content: [],
          structuredContent: {
            content_refs: [
              { ref: 'p1:1', role: 'text', name: 'First', frame: 'main', actions: [] },
              { ref: 'p1:2', role: 'text', name: 'Second', frame: 'main', actions: ['click'] },
              { ref: 'p1:3', role: 'text', name: 'Third', frame: 'main', actions: [] },
            ],
          },
        },
        'get_browser_state',
      );
      const mixedActionText = mixedActions.content
        .map((item) => ('text' in item ? item.text : ''))
        .join('\n');
      expect(mixedActionText).toContain('Content ref defaults: {"frame":"main"}');
      expect(mixedActionText).toContain('"frame":"main"');
      expect(mixedActionText).toContain('"actions":["click"]');
      expect(mixedActionText).toContain('"actions":[]');
    });

    it('keeps fields on a single content ref without adding a defaults header', () => {
      const result = toPiToolResult(
        {
          content: [],
          structuredContent: {
            content_refs: [
              { ref: 'p1:1', role: 'text', name: 'Single result', frame: 'main', actions: [] },
            ],
          },
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).not.toContain('Content ref defaults:');
      expect(text).toContain('"frame":"main"');
      expect(text).toContain('"actions":[]');
    });

    it('preserves readable author and body order across different roles', () => {
      const result = toPiToolResult(
        {
          structuredContent: {
            content_refs: [
              { ref: 'p1:1', role: 'generic', name: 'Author A' },
              { ref: 'p1:2', role: 'statictext', name: 'Body A' },
              { ref: 'p1:3', role: 'generic', name: 'Author B' },
              { ref: 'p1:4', role: 'paragraph', name: 'Body B' },
            ],
          },
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text.indexOf('Author A')).toBeLessThan(text.indexOf('Body A'));
      expect(text.indexOf('Body A')).toBeLessThan(text.indexOf('Author B'));
      expect(text.indexOf('Author B')).toBeLessThan(text.indexOf('Body B'));
    });

    it('does not duplicate snapshot_id when the driver text already carries it', () => {
      const result = toPiToolResult(
        {
          content: [
            {
              type: 'text',
              text: 'window_id=1234 pid=567 snapshot_id=s00000009 elements=148\n',
            },
          ],
          structuredContent: { snapshot_id: 's00000009', element_count: 148 },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text.match(/snapshot_id=s00000009/g)?.length).toBe(1);
    });

    it('surfaces degraded_reason with a recovery hint', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'window_id=7825 pid=9229 elements=0\n' }],
          structuredContent: {
            degraded: true,
            degraded_reason: 'off_space_or_ax_unresolved',
          },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('off_space_or_ax_unresolved');
      expect(text).toContain('bring_to_front');
      expect(text).not.toContain('delivery_mode');
    });

    it('hints max_elements when the tree is absent from text but elements exist', () => {
      const result = toPiToolResult(
        {
          content: [
            {
              type: 'text',
              text: 'window_id=8160 pid=31271 size=1920x1080 elements=245\n\u26a0\ufe0f AX tree truncated at 2000 nodes\n',
            },
          ],
          structuredContent: { element_count: 245, elements: [{ element_index: 0 }] },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('max_elements');
    });

    it('does not hint max_elements when the tree is present in text', () => {
      const result = toPiToolResult(
        {
          content: [
            {
              type: 'text',
              text: 'window_id=8419 pid=47184 elements=2\n- [0] AXWindow "Calculator"\n  - [1] AXButton\n',
            },
          ],
          structuredContent: { element_count: 2, elements: [{ element_index: 0 }] },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).not.toContain('max_elements');
    });

    it('hints max_elements when element_count is absent but elements exist', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'window_id=1 pid=1 elements=0\n' }],
          structuredContent: { elements: [{ element_index: 0 }] },
        },
        'get_window_state',
      );
      expect(result.content.map((c) => ('text' in c ? c.text : '')).join('\n')).toContain(
        'max_elements',
      );
    });

    it('adds no enrichment when windows is an empty array', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Found 0 window(s).' }],
          structuredContent: { windows: [] },
        },
        'list_windows',
      );
      expect(result.content).toEqual([{ type: 'text', text: 'Found 0 window(s).' }]);
    });

    it('renders list_windows records, on-screen first, capped at 20', () => {
      const windows = Array.from({ length: 30 }, (_, index) => ({
        window_id: 1000 + index,
        pid: 42,
        app_name: 'Google Chrome',
        title: `tab ${index}`,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        // First 25 are off-screen; last 5 are on-screen + current space.
        is_on_screen: index >= 25,
        on_current_space: index >= 25,
      }));
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Found 30 window(s).' }],
          structuredContent: { windows },
        },
        'list_windows',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('window_id=1025');
      expect(text).toContain('window_id=1029');
      expect(text).not.toContain('window_id=1015');
      expect(text).not.toContain('window_id=1024');
      expect(text.match(/window_id=/g)?.length).toBe(20);
    });

    it('passes through unchanged when structuredContent is null', () => {
      const result = toPiToolResult({ content: [{ type: 'text', text: 'plain' }] }, 'list_windows');
      expect(result.content).toEqual([{ type: 'text', text: 'plain' }]);
      expect(result.details).toBeUndefined();
    });

    it('does not throw on schema drift (windows not an array, unknown fields)', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Found 0 window(s).' }],
          structuredContent: { windows: 'oops', extra: { nested: true } },
        },
        'list_windows',
      );
      expect(result.content.map((c) => ('text' in c ? c.text : '')).join(' ')).toBe(
        'Found 0 window(s).',
      );
    });

    it('keeps enrichment within the result budget', () => {
      const result = toPiToolResult(
        {
          content: [
            {
              type: 'image',
              data: 'a'.repeat(30_000),
              mimeType: 'image/png',
            },
            { type: 'text', text: 'Found 30 window(s).' },
          ],
          structuredContent: {
            windows: Array.from({ length: 30 }, (_, index) => ({
              window_id: index + 1,
              pid: 1,
              app_name: 'A'.repeat(60),
              title: 'B'.repeat(120),
              bounds: { x: 0, y: 0, width: 1, height: 1 },
              is_on_screen: true,
              on_current_space: true,
            })),
          },
        },
        'list_windows',
      );
      const payload = {
        content: result.content,
        details: result.details,
      };
      expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(
        DEFAULT_MAX_BYTES,
      );
    });
  });
});
