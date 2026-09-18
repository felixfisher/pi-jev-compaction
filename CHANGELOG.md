# Changelog

All notable changes to this experimental project are documented here.

## 0.1.0 - 2026-09-18

### Experimental

Initial public snapshot of `pi-jev-compaction`.

- Pi extension package that uses TypeSafe Jev to keep, truncate, or drop old tool calls while preserving user and assistant text.
- Default `enabled: false`. `enabled` only gates new TypeSafe requests; stored details still replay locally.
- Absolute replay token budget: `targetReplayTokens` 80,000 and `maxReplayTokens` 100,000. A minimum-replay precheck skips Jev when even dropping all unprotected pairs still exceeds max; the post-Jev max check remains. Over max fails open (`max_replay_tokens`).
- Fail-open on missing API key, HTTP errors, malformed answers, or insufficient reduction.
- Compaction details store replay messages in the session JSONL without rewriting original history.
- `/jev-status` reports enablement, key presence, budget, and last stats. No API key is logged.
- Mocked default tests; optional `npm run test:real-session` is not part of CI.
