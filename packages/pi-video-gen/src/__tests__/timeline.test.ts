import { describe, expect, it } from 'vitest';
import { parseTimelineSpec } from '../timeline.js';

describe('parseTimelineSpec', () => {
  const valid = JSON.stringify({
    title: 't',
    segments: [{ id: 's1', image: '/a.png', durationSec: 5 }],
  });

  it('accepts a minimal valid spec', () => {
    const spec = parseTimelineSpec(valid);
    expect(spec.segments).toHaveLength(1);
  });

  it('accepts a trimmed video segment with fit and source-audio controls', () => {
    const spec = parseTimelineSpec(
      JSON.stringify({
        segments: [
          {
            id: 'demo',
            video: '/demo.mp4',
            durationSec: 4,
            trimStartSec: 1.5,
            fit: 'cover',
            sourceAudio: { volume: 0.25 },
          },
        ],
      }),
    );

    expect(spec.segments[0]).toMatchObject({
      video: '/demo.mp4',
      trimStartSec: 1.5,
      fit: 'cover',
      sourceAudio: { volume: 0.25 },
    });
  });

  it('requires exactly one media source and validates video-only options', () => {
    const make = (segment: Record<string, unknown>) =>
      JSON.stringify({ segments: [{ id: 's1', durationSec: 3, ...segment }] });

    expect(() => parseTimelineSpec(make({}))).toThrow(/exactly one of image or video/);
    expect(() => parseTimelineSpec(make({ image: '/a.png', video: '/a.mp4' }))).toThrow(
      /exactly one of image or video/,
    );
    expect(() => parseTimelineSpec(make({ video: '/a.mp4', durationSec: 'auto' }))).toThrow(
      /video segments require a numeric durationSec/,
    );
    expect(() => parseTimelineSpec(make({ image: '/a.png', trimStartSec: 1 }))).toThrow(
      /trimStartSec is only valid for video/,
    );
    expect(() => parseTimelineSpec(make({ video: '/a.mp4', trimStartSec: -1 }))).toThrow(
      /trimStartSec must be a non-negative number/,
    );
    expect(() => parseTimelineSpec(make({ video: '/a.mp4', fit: 'stretch' }))).toThrow(
      /fit must be "contain" or "cover"/,
    );
    expect(() => parseTimelineSpec(make({ video: '/a.mp4', motion: 'zoom-in' }))).toThrow(
      /motion is only valid for image segments/,
    );
    expect(() => parseTimelineSpec(make({ video: '/a.mp4', sourceAudio: { volume: 3 } }))).toThrow(
      /sourceAudio.volume must be a number from 0 to 2/,
    );
    expect(() => parseTimelineSpec(make({ video: '/a.mp4', sourceAudio: null }))).toThrow(
      /sourceAudio must be an object/,
    );
    expect(() =>
      parseTimelineSpec(make({ video: '/a.mp4', sourceAudio: { muted: 'yes' } })),
    ).toThrow(/sourceAudio.muted must be a boolean/);
    expect(() => parseTimelineSpec(make({ image: '/a.png', sourceAudio: {} }))).toThrow(
      /sourceAudio is only valid for video/,
    );
  });

  it('rejects invalid JSON and missing segments', () => {
    expect(() => parseTimelineSpec('{no')).toThrow(/not valid JSON/);
    expect(() => parseTimelineSpec('{}')).toThrow(/non-empty "segments" array/);
    expect(() => parseTimelineSpec('{"segments":[]}')).toThrow(/non-empty "segments" array/);
  });

  it('rejects duplicate ids and non-string ids', () => {
    const dup = JSON.stringify({
      segments: [
        { id: 's1', image: '/a.png', durationSec: 3 },
        { id: 's1', image: '/b.png', durationSec: 3 },
      ],
    });
    expect(() => parseTimelineSpec(dup)).toThrow(/Duplicate segment id/);
    const numeric = JSON.stringify({ segments: [{ id: 1, image: '/a.png', durationSec: 3 }] });
    expect(() => parseTimelineSpec(numeric)).toThrow(/id must be a string/);
  });

  it('rejects unsafe ids, missing image, bad durations', () => {
    expect(() =>
      parseTimelineSpec(
        JSON.stringify({ segments: [{ id: '../x', image: '/a.png', durationSec: 3 }] }),
      ),
    ).toThrow(/Invalid segment id/);
    expect(() =>
      parseTimelineSpec(JSON.stringify({ segments: [{ id: 's1', durationSec: 3 }] })),
    ).toThrow(/exactly one of image or video/);
    expect(() =>
      parseTimelineSpec(
        JSON.stringify({ segments: [{ id: 's1', image: '/a.png', durationSec: 0.1 }] }),
      ),
    ).toThrow(/durationSec must be "auto" \(from narration audio\) or a number/);
    expect(() =>
      parseTimelineSpec(
        JSON.stringify({ segments: [{ id: 's1', image: '/a.png', durationSec: 'auto' }] }),
      ),
    ).toThrow(/requires narration/);
  });

  it('validates motion/transition/output fields', () => {
    const make = (extra: Record<string, unknown>) =>
      JSON.stringify({
        segments: [
          { id: 's1', image: '/a.png', durationSec: 3, ...extra },
          { id: 's2', image: '/b.png', durationSec: 3 },
        ],
      });
    expect(() => parseTimelineSpec(make({ motion: 'fly' }))).toThrow(/motion must be one of/);
    expect(() =>
      parseTimelineSpec(make({ transitionTo: { type: 'warp', style: 'fade', durationSec: 1 } })),
    ).toThrow('transitionTo.type must be "xfade"');
    expect(() =>
      parseTimelineSpec(make({ transitionTo: { type: 'xfade', style: 'warp', durationSec: 1 } })),
    ).toThrow(/transitionTo.style must be one of/);
    expect(() =>
      parseTimelineSpec(
        JSON.stringify({
          output: { resolution: 'big' },
          segments: [{ id: 's1', image: '/a.png', durationSec: 3 }],
        }),
      ),
    ).toThrow(/resolution must look like/);
    expect(() =>
      parseTimelineSpec(
        JSON.stringify({
          output: { fps: 0 },
          segments: [{ id: 's1', image: '/a.png', durationSec: 3 }],
        }),
      ),
    ).toThrow(/fps must be an integer/);
  });

  it('rejects non-object output and overlay values', () => {
    for (const output of [null, 'bad', []]) {
      expect(() =>
        parseTimelineSpec(
          JSON.stringify({
            output,
            segments: [{ id: 's1', image: '/a.png', durationSec: 3 }],
          }),
        ),
      ).toThrow(/output must be an object/);
    }
    for (const overlay of [null, 'bad', []]) {
      expect(() =>
        parseTimelineSpec(
          JSON.stringify({
            segments: [{ id: 's1', image: '/a.png', durationSec: 3, overlay }],
          }),
        ),
      ).toThrow(/overlay must be an object/);
    }
  });

  it('rejects zero, odd, and unreasonably large output dimensions', () => {
    const withResolution = (resolution: string) =>
      JSON.stringify({
        output: { resolution },
        segments: [{ id: 's1', image: '/a.png', durationSec: 3 }],
      });

    expect(() => parseTimelineSpec(withResolution('000x000'))).toThrow(/resolution/);
    expect(() => parseTimelineSpec(withResolution('321x180'))).toThrow(/resolution/);
    expect(() => parseTimelineSpec(withResolution('9998x9998'))).toThrow(/resolution/);
  });

  it('rejects falsey non-string output values', () => {
    for (const resolution of [null, '', 0, false]) {
      expect(() =>
        parseTimelineSpec(
          JSON.stringify({
            output: { resolution },
            segments: [{ id: 's1', image: '/a.png', durationSec: 3 }],
          }),
        ),
      ).toThrow(/output\.resolution must look like/);
    }
    expect(() =>
      parseTimelineSpec(
        JSON.stringify({
          output: { fps: null },
          segments: [{ id: 's1', image: '/a.png', durationSec: 3 }],
        }),
      ),
    ).toThrow(/output\.fps must be an integer/);
  });

  it('rejects malformed optional segment fields', () => {
    const make = (extra: Record<string, unknown>) =>
      JSON.stringify({ segments: [{ id: 's1', image: '/a.png', durationSec: 3, ...extra }] });
    for (const transitionTo of [null, false, 0, '', []]) {
      expect(() => parseTimelineSpec(make({ transitionTo }))).toThrow(
        /transitionTo must be an object/,
      );
    }
    expect(() => parseTimelineSpec(make({ motion: null }))).toThrow(/motion must be one of/);
    for (const position of [null, false, 0, '']) {
      expect(() => parseTimelineSpec(make({ overlay: { title: 'x', position } }))).toThrow(
        /overlay\.position must be one of/,
      );
    }
  });

  it('rejects malformed optional top-level text and path fields', () => {
    const make = (extra: Record<string, unknown>) =>
      JSON.stringify({
        ...extra,
        segments: [{ id: 's1', image: '/a.png', durationSec: 3 }],
      });

    expect(() => parseTimelineSpec(make({ title: {} }))).toThrow(/title must be a string/);
    expect(() => parseTimelineSpec(make({ voice: '' }))).toThrow(
      /voice must be a non-empty string/,
    );
    expect(() => parseTimelineSpec(make({ bgm: '' }))).toThrow(/bgm must be a non-empty string/);
  });

  it('accepts auto duration with narration and full options', () => {
    const spec = parseTimelineSpec(
      JSON.stringify({
        output: { resolution: '1920x1080', fps: 25 },
        segments: [
          {
            id: 's1',
            image: '/a.png',
            durationSec: 'auto',
            narration: '你好',
            motion: 'kenburns-in',
            transitionTo: { type: 'xfade', style: 'fade', durationSec: 0.8 },
            overlay: { title: '标题', subtitle: '副标题', position: 'bottom-center' },
          },
          { id: 's2', image: '/b.png', durationSec: 3 },
        ],
      }),
    );
    expect(spec.segments[0]!.motion).toBe('kenburns-in');
  });

  it('accepts and validates burned-subtitle styling', () => {
    const make = (subtitles: unknown) =>
      JSON.stringify({
        subtitles,
        segments: [{ id: 's1', image: '/a.png', durationSec: 3, narration: '你好' }],
      });
    const accepted = parseTimelineSpec(
      make({
        mode: 'burn',
        fontSize: 32,
        textColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 0.6,
      }),
    );
    expect(accepted.subtitles).toMatchObject({ mode: 'burn', fontSize: 32 });

    for (const subtitles of [null, 'burn', []]) {
      expect(() => parseTimelineSpec(make(subtitles))).toThrow(/subtitles must be an object/);
    }
    expect(() => parseTimelineSpec(make({ mode: 'both' }))).toThrow(
      /subtitles.mode must be "soft" or "burn"/,
    );
    expect(() => parseTimelineSpec(make({ fontSize: 4 }))).toThrow(
      /subtitles.fontSize must be a number from 12 to 256/,
    );
    expect(() => parseTimelineSpec(make({ textColor: 'white' }))).toThrow(
      /subtitles.textColor must be a six-digit hex color/,
    );
    expect(() => parseTimelineSpec(make({ backgroundOpacity: 2 }))).toThrow(
      /subtitles.backgroundOpacity must be a number from 0 to 1/,
    );
    expect(() => parseTimelineSpec(make({ mode: 'soft', fontSize: 32 }))).toThrow(
      /subtitle styling requires subtitles.mode "burn"/,
    );
  });

  it('validates the explicit TTS failure policy', () => {
    const accepted = parseTimelineSpec(
      JSON.stringify({
        ttsFailureMode: 'silent-subtitles',
        segments: [{ id: 's1', image: '/a.png', durationSec: 3, narration: '你好' }],
      }),
    );
    expect(accepted.ttsFailureMode).toBe('silent-subtitles');
    expect(() =>
      parseTimelineSpec(
        JSON.stringify({
          ttsFailureMode: 'silent',
          segments: [{ id: 's1', image: '/a.png', durationSec: 3, narration: '你好' }],
        }),
      ),
    ).toThrow(/ttsFailureMode must be/);
  });
});
