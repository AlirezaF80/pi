# Render script and recovery

Create `<outputDir>/<jobId>/render-input.json`. The job ID and each shot ID use letters, digits, dash or underscore. The parent directory is the immutable job. Use `video_generate` directly when batch automation and recovery are unnecessary.

```json
{
  "title": "Mixed product film",
  "style": "cinematic product demo",
  "shots": [
    {"id":"opening","prompt":{"visuals":"static medium shot","action":"presenter lifts the product"},"firstFramePath":"/absolute/path/opening.png","durationSec":5},
    {"id":"demo","videoPath":"/absolute/path/demo.mp4"}
  ],
  "assembly": {"type":"remotion","projectDir":"/absolute/path/project","compositionId":"Promo"}
}
```

Each shot has exactly one source. `videoPath` uses a local video and has no prompt, frame, reference asset or duration fields. A generated shot uses a structured `prompt` with `visuals` and `action`; if there is no first frame, add film-level `style` and shot-level `scene`. Use `referenceAssets` for provider-managed trusted assets. The plugin snapshots local inputs, records remote task handles immediately and does not submit paid work again when resuming a finished shot.

`assembly` is optional. Without it, clips are concatenated in shot order. For a local FFmpeg timeline, use `{"type":"timeline","timeline":{"segments":[{"id":"a","shotId":"opening","durationSec":5},{"id":"b","shotId":"demo","durationSec":5}]}}`; timeline segments may also carry supported overlay, narration and transition fields. Every segment must refer to an existing shot ID and must not supply a separate `video` or `image`. For Remotion, pass `projectDir`, `compositionId`, optional `entryPoint`, `inputProps`, `assets` and `browserExecutable`. The plugin supplies a `videoGenAssets` map keyed by shot ID and merges extra assets with distinct IDs.

Before the first paid submit, the script checks all shot references, existing media, model capabilities and assembly environment. Remotion additionally bundles the project with placeholder video, selects the composition and renders frame zero. This does not prove that the eventual generated codec or duration is compatible; downloaded clips are checked again. If assembly fails after generation, rerun the same script after fixing the environment. The saved shot files and handles remain; changing frozen project source, original public resources, existing assets or the script requires a new job.

Approval is scoped to the generated shots, provider/account, model and duration. Reuse an existing approval only for the same scope. On ambiguous remote submission, inspect the provider console, then use `/video-gen recover <jobId> <shotId> reset` only when the task is confirmed absent or `adopt <taskId>` when found. Cancellation stops local work and may not cancel provider billing. A legacy completed manifest without a saved final SHA-256 cannot verify the old film; compose its saved clips in a new job directory.
