# Remotion handoff

Use Remotion when the work needs exact text, UI, charts, editable React animation or frame control. Write an ordinary local Remotion project with an entry that calls `registerRoot()`. Install matching `remotion`, `@remotion/bundler`, `@remotion/renderer`, React and React DOM in that project. Provide an installed Chrome or Chromium binary through `browserExecutable` or `REMOTION_BROWSER_EXECUTABLE`. The plugin does not install packages or download a browser during a tool call.

Write `<jobDir>/remotion-input.json` and call `video_compose({"composeSpecPath":".../remotion-input.json"})`:

```json
{"projectDir":"/absolute/path/remotion-project","compositionId":"Promo","assets":{"demo":"/absolute/path/demo.mp4"},"inputProps":{"title":"Product"}}
```

The project must be inside the trusted working directory. Set `entryPoint` to a project-relative file when the usual `src/index.ts`, `src/index.tsx`, `src/index.js` or `src/index.jsx` is missing or ambiguous. `assets` paths stay on the Node side. The plugin copies the project's original `public/` tree into the job snapshot, keeps relative paths such as `logo.png` and `fonts/brand.woff`, then copies injected assets into reserved `__pi_video_gen__/`. If the original public tree already uses this namespace, the call fails without overwriting it. The plugin passes `videoGenAssets: { demo: "__pi_video_gen__/demo.mp4" }` in `inputProps`; the composition uses `staticFile(videoGenAssets.demo)`. Ordinary `staticFile('logo.png')` and font references continue to work.

Treat the configured video output directory as generated artifacts. Keep the Remotion entry and every source file it imports outside that directory; it is excluded from the frozen project fingerprint so sibling jobs cannot invalidate one another. The entry is checked and rejected if it is inside the output directory. Do not configure video output inside the project's `public/` tree.

For `video_render`, use `assembly.type: "remotion"` with the same project fields. Every shot ID appears in `videoGenAssets` after download, and additional `assembly.assets` may be supplied under distinct IDs. Before a paid submission, the plugin builds a temporary public snapshot with browser-playable placeholder video and renders one frame. After download it rebuilds the snapshot with actual clips. Original project source, dependency files and original `public/` content are frozen separately from generated clip hashes; adding generated clips does not invalidate the paid input fingerprint.

For batch `video_render`, the selected composition must expose `props.videoGenShotTimesSec`, a map from every shot ID to a time in seconds where that shot is visible in the finished film. Set it in `defaultProps` for a fixed edit, or return it from `calculateMetadata` when timing depends on the actual clips. The plugin checks the map during the placeholder preflight, then reads the actual map after rendering and extracts final QC frames at those times. The values must be finite and within the composition duration. Direct `video_compose` does not need this map.

The final MP4 and assembly manifest live under `<jobDir>/assembly/` for `video_render`; direct `video_compose` writes them in its own job directory. Preserve the Remotion project as an editable deliverable. Inspect actual frames after rendering; a successful bundle and media probe do not establish visual correctness.

Remotion has its own [license terms and FAQ](https://www.remotion.dev/docs/license/faq). The project owner should check the applicable terms before using this path in commercial automation. The plugin does not bundle Remotion code.
