# bloom-cover-image-editor

Local tool for localizing children’s book covers.

## Dev

- Install: `pnpm install`
- Run: `pnpm dev`

## Notes

- API keys are stored in `localStorage` (this is intended for local use).
- Last title, selected model, prompt template, and the most recent input image are stored in `localStorage` for convenience.
- Output images are transient (not persisted) to avoid excessive storage use.
- OpenRouter image-to-image support depends on the selected model/provider; some models will return text only.

## HMR troubleshooting

If Hot Module Reloading feels flaky on Windows (missed file changes, slow updates), you can opt into polling-based file watching:

- PowerShell: `setx VITE_USE_POLLING 1`
- Then restart `pnpm dev`

Optional:

- `VITE_POLLING_INTERVAL` (milliseconds, default `100`)
