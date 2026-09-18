# Security

## Reporting

Please report vulnerabilities through GitHub Security Advisories on this repository. Do not open a public issue for a suspected secret leak or injection path.

## Data sent to TypeSafe

When the extension is **explicitly enabled** and `TYPESAFE_API_KEY` is set, compaction sends a redacted state to `https://api.typesafe.ai/v1/systemone`. That state includes tool names, truncated/redacted arguments, result lengths, and short tags. It does not include full tool results. User/assistant snippets are secret-redacted first.

If the extension is disabled (the install default), it does not call TypeSafe.

## Secrets

- Provide `TYPESAFE_API_KEY` via environment variable only.
- The extension never writes the key to session JSONL, logs, compaction details, or `/jev-status`.
- Rotate the key if it may have appeared in a shell history or CI log.

## Fail-open

Network failures, HTTP 401/422, malformed answers, and replay budgets over `maxReplayTokens` skip Jev compaction and leave Pi's native summarizer in charge.
