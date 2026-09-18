import { redactErrorMessage } from "./2026-09-18_redact.ts";
import { collectAnswers } from "./2026-09-18_state.ts";
import type { JevAnswer, JevJudge, JevJudgeResult, NoulQuestion } from "./2026-09-18_types.ts";

export const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai";
export const SYSTEMONE_PATH = "/v1/systemone";

export class JevRequestError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, options?: { status?: number; retryable?: boolean }) {
    super(message);
    this.name = "JevRequestError";
    this.status = options?.status;
    this.retryable = options?.retryable ?? false;
  }
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function createJevClient(options: JevClientOptions): JevJudge {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRetries = options.maxRetries ?? 2;
  const baseUrl = (options.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_TYPESAFE_BASE_URL).replace(/\/$/, "");
  const sleep = options.sleep ?? defaultSleep;

  return {
    async judge(input): Promise<JevJudgeResult> {
      const requiredIds = Object.keys(input.questions);
      if (requiredIds.length === 0) {
        return { model: input.model, answers: {}, requests: 0 };
      }
      const body = JSON.stringify({
        state: input.state,
        model: input.model,
        questions: input.questions,
      });
      let lastError: unknown;
      let requests = 0;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (input.signal?.aborted) {
          throw new JevRequestError("aborted", { retryable: false });
        }
        try {
          requests += 1;
          const response = await fetchWithTimeout(fetchImpl, `${baseUrl}${SYSTEMONE_PATH}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
            },
            body,
            timeoutMs,
            signal: input.signal,
          });
          if (response.status === 429 || response.status === 529) {
            const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
            lastError = new JevRequestError(`typesafe_http_${response.status}`, {
              status: response.status,
              retryable: true,
            });
            if (attempt >= maxRetries) break;
            await sleep(retryDelay(attempt, retryAfter), input.signal);
            continue;
          }
          if (response.status === 401 || response.status === 422) {
            throw new JevRequestError(`typesafe_http_${response.status}`, {
              status: response.status,
              retryable: false,
            });
          }
          if (!response.ok) {
            lastError = new JevRequestError(`typesafe_http_${response.status}`, {
              status: response.status,
              retryable: response.status >= 500,
            });
            if (attempt >= maxRetries || response.status < 500) break;
            await sleep(retryDelay(attempt), input.signal);
            continue;
          }
          const parsed = await parseJson(response);
          const answersRaw = isObject(parsed) && isObject(parsed.answers) ? parsed.answers : undefined;
          if (!answersRaw) {
            throw new JevRequestError("malformed_response", { retryable: false });
          }
          const collected = collectAnswers(requiredIds, answersRaw);
          if (!collected.ok) {
            throw new JevRequestError(collected.reason, { retryable: false });
          }
          const model = isObject(parsed) && typeof parsed.model === "string" ? parsed.model : input.model;
          return { model, answers: collected.answers, requests };
        } catch (error) {
          if (error instanceof JevRequestError && !error.retryable) throw sanitizeError(error, options.apiKey);
          if (input.signal?.aborted) throw new JevRequestError("aborted", { retryable: false });
          lastError = error;
          if (attempt >= maxRetries || !isRetryable(error)) break;
          await sleep(retryDelay(attempt), input.signal);
        }
      }
      throw sanitizeError(lastError, options.apiKey);
    },
  };
}

export function splitJudgeByChunks(
  client: JevJudge,
  chunks: Array<{ state: unknown; questions: Record<string, NoulQuestion> }>,
  model: string,
  signal?: AbortSignal,
): Promise<JevJudgeResult> {
  return (async () => {
    const answers: Record<string, JevAnswer> = {};
    let requests = 0;
    let returnedModel = model;
    for (const chunk of chunks) {
      const result = await client.judge({ state: chunk.state, questions: chunk.questions, model, signal });
      Object.assign(answers, result.answers);
      requests += result.requests;
      returnedModel = result.model || returnedModel;
    }
    return { model: returnedModel, answers, requests };
  })();
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("timeout")), init.timeoutMs);
  const abortFromParent = () => timeout.abort(init.signal?.reason);
  init.signal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    const fetchPromise = fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: timeout.signal,
    });
    const abortPromise = new Promise<Response>((_, reject) => {
      const onAbort = () => {
        if (init.signal?.aborted) reject(new JevRequestError("aborted", { retryable: false }));
        else reject(new JevRequestError("timeout", { retryable: true }));
      };
      if (timeout.signal.aborted) onAbort();
      else timeout.signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([fetchPromise, abortPromise]);
  } catch (error) {
    if (error instanceof JevRequestError) throw error;
    if (init.signal?.aborted) throw new JevRequestError("aborted", { retryable: false });
    if (timeout.signal.aborted && !init.signal?.aborted) {
      throw new JevRequestError("timeout", { retryable: true });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JevRequestError("malformed_json", { retryable: false });
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof JevRequestError) return error.retryable;
  if (error instanceof Error && /timeout|network|fetch|ECONNRESET|ENOTFOUND/i.test(error.message)) return true;
  return false;
}

function retryDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(5_000, Math.max(50, retryAfterMs));
  const base = 200 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 50);
  return Math.min(2_000, base + jitter);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new JevRequestError("aborted", { retryable: false }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JevRequestError("aborted", { retryable: false }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sanitizeError(error: unknown, apiKey: string): JevRequestError {
  if (error instanceof JevRequestError) {
    return new JevRequestError(redactErrorMessage(error.message, apiKey), {
      status: error.status,
      retryable: error.retryable,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new JevRequestError(redactErrorMessage(message, apiKey), { retryable: false });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
