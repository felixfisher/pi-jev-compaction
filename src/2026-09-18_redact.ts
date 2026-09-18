import type { PrivacyMode } from "./2026-09-18_types.ts";

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(sk-ant-[A-Za-z0-9_-]{8,})\b/g,
  /\b(sk-or-[A-Za-z0-9_-]{8,})\b/g,
  /\b(gsk_[A-Za-z0-9_-]{8,})\b/g,
  /\b(xai-[A-Za-z0-9_-]{8,})\b/g,
  /\b(AIza[A-Za-z0-9_-]{8,})\b/g,
  /\b(AKIA[A-Z0-9]{12,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(ya29\.[A-Za-z0-9_-]{10,})\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(Bearer\s+[A-Za-z0-9._\-+=/]{8,})\b/gi,
];

const KEY_VALUE_PATTERNS: RegExp[] = [
  /\b(api[_-]?key|access[_-]?token|secret|password|passwd|authorization|token|private[_-]?key)\b(\s*[:=]\s*)([^\s,;]+)/gi,
  /\b(TYPESAFE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|XAI_API_KEY)\b(\s*[:=]\s*)([^\s,;]+)/g,
];

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[^/\s"'`]+/g;

export function maskSecret(value: string): string {
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 4)}…[redacted]`;
}

export function redactSecrets(text: string, privacyMode: PrivacyMode = "balanced"): string {
  if (privacyMode === "off" || text === "") return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  for (const pattern of KEY_VALUE_PATTERNS) {
    out = out.replace(pattern, (_match, key: string, sep: string) => `${key}${sep}[redacted]`);
  }
  if (privacyMode === "strict") {
    out = out.replace(EMAIL_PATTERN, "[redacted-email]");
    out = out.replace(HOME_PATH_PATTERN, "/[redacted-home]");
  }
  return out;
}

export function redactErrorMessage(message: string, apiKey?: string): string {
  let out = redactSecrets(message, "balanced");
  if (apiKey && apiKey.length > 0) {
    out = out.split(apiKey).join("[redacted]");
  }
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return out;
}

export function redactUnknown(value: unknown, privacyMode: PrivacyMode, depth = 0): unknown {
  if (privacyMode === "off") return value;
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactSecrets(value, privacyMode);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redactUnknown(item, privacyMode, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (/key|token|secret|password|authorization/i.test(key) && typeof child === "string") {
        out[key] = "[redacted]";
      } else {
        out[key] = redactUnknown(child, privacyMode, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15))}…[truncated]`;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}
