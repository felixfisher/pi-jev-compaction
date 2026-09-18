# Contributing

This package is **experimental**. Small, reviewable changes are welcome.

## Setup

```bash
npm ci
npm run typecheck
npm test
npm run smoke
```

Do not commit `node_modules`, `.env`, session JSONL files, or tarballs.

## Tests

- Default `npm test` must stay mock-only and offline.
- `npm run test:real-session` calls the real TypeSafe API. It is opt-in, requires `TYPESAFE_API_KEY` and `PI_SESSION_FILE`, copies the session, and never writes the original. Do not add it to CI.
- Reports from real tests must contain aggregate numbers only.

## Privacy

Never commit API keys, session transcripts, client names, or tool outputs. Config examples must not include `TYPESAFE_API_KEY` values.

## Pull requests

1. Keep the default disabled (`enabled: false`) unless the change is specifically about opt-in.
2. Fail open: if Jev cannot safely compact, return `undefined` and let Pi's native compaction run.
3. Update `CHANGELOG.md` for user-visible changes.
