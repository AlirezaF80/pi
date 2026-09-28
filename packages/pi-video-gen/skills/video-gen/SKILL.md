---
name: video-gen
description: "Choose per-shot video sources and compose with existing media, direct video-model calls, a recoverable render script, FFmpeg, or a trusted Remotion project. Use when the deliverable is video."
---

# Video creation

Choose each shot's source first: existing video, a video-model clip, or graphics built in Remotion. Then choose assembly: compatible clips use lossless `video_compose`; mixed images, overlays, narration and subtitles use its FFmpeg timeline; precise UI, charts, typography or editable frame animation use a Remotion project. A project can mix all three shot sources. Story structure, 3–5 shots, character portraits, and first/last frames are optional creative choices, not execution gates.

| Need | Tool |
|---|---|
| One or several model clips under direct control | Call `video_generate` for each missing clip, then `video_compose` if assembly is needed |
| Existing media or a prepared Remotion project | `video_compose` with `compose-input.json`, `timeline-input.json`, or `remotion-input.json` |
| A prepared batch script with generated and existing shots, durable remote-task recovery and assembly | `video_render` with `render-input.json` |

`video_generate` is a direct paid primitive. `video_render` is an optional project automation workflow, not a prerequisite for calling the model. All-local `video_render` scripts need no model credentials. Call `video_capabilities` only for generated shots. Reuse existing media; generate only missing visuals. The model prompt is a structured `prompt` object, never a pre-joined string. Read [video-render-workflow.md](references/video-render-workflow.md) for spec examples and recovery, and [remotion-handoff.md](references/remotion-handoff.md) for the Remotion asset contract.

Before a paid model call, state the generated clip count and duration, provider/account context and expected cost magnitude. Reuse existing explicit approval for the unchanged request; ask again only when its scope changes. For Seedance references with recognizable real people, use a preset avatar or authorized-person asset from the active account/project. Do not silently drop unsupported inputs; agree on a degradation or change model/spec. Network TTS sends narration text to Microsoft Edge; disclose this before enabling it. Pure local composition needs no paid-model confirmation.

Job specs are immutable per directory. An interrupted `video_generate` resumes with its returned `jobId`; an interrupted `video_render` resumes by rerunning the same spec. A cancelled local poll may leave paid remote tasks running. If submit is ambiguous, inspect the provider console and use `/video-gen recover` before any retry. Never delete a shot directory to force regeneration. New creative revisions use a new job directory; a completed video or QC artifact whose hash changed is not silently rebuilt.

A successful render provides media probes and QC frames. Inspect the actual frames and subtitle timing before calling the work visually accepted. Remotion runs trusted local project code; install its dependencies and Chrome/Chromium in that project, and keep the editable source with the delivered MP4. The official Remotion skills are optional creation guidance and are not bundled with this plugin.
