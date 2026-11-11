/**
 * The one seam between AURA and any language model.
 *
 * Implementations exist for the Claude Artifact runtime, the AURA server
 * (Anthropic SDK or any OpenAI-compatible endpoint) and a scripted demo model.
 * Swapping models means supplying a different LlmClient; nothing else changes.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Abstract quality/latency tier; each provider maps it to a concrete model. */
export type LlmTier = 'fast' | 'balanced' | 'deep';

export interface LlmRequest {
  /** Standing instructions (stable across a conversation; cache-friendly). */
  system: string;
  /** Per-turn context appended after the system text (memories, time, summaries). */
  context?: string;
  messages: ChatMessage[];
  tier: LlmTier;
  /** 'chat' = spoken reply; 'extract' = background JSON task (cheaper model is fine). */
  purpose: 'chat' | 'extract';
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  truncated?: boolean;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmClient {
  /** Short identifier shown in diagnostics, e.g. "claude-artifact", "anthropic", "demo". */
  readonly id: string;
  /**
   * Generate a reply, calling `onDelta` with each new piece of text as it arrives.
   * Resolves with the full text. Rejects with an LlmError.
   */
  stream(req: LlmRequest, onDelta: (delta: string) => void): Promise<LlmResult>;
}

export type LlmErrorCode =
  | 'aborted'
  | 'not_configured'
  | 'unauthorized'
  | 'consent_denied'
  | 'rate_limited'
  | 'refused'
  | 'too_large'
  | 'network'
  | 'unavailable'
  | 'bad_response';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  /** Text produced before the failure, if any. */
  readonly partial?: string;
  readonly retryable: boolean;
  constructor(code: LlmErrorCode, message: string, opts: { partial?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.partial = opts.partial;
    this.retryable = code === 'network' || code === 'unavailable';
    if (opts.cause !== undefined) (this as any).cause = opts.cause;
  }
}

export function isAbort(err: unknown): boolean {
  return (
    (err instanceof LlmError && err.code === 'aborted') ||
    (typeof err === 'object' && err !== null && (err as any).name === 'AbortError')
  );
}

/** Extract the first JSON value from model output that may be fenced or chatty. */
export function extractJson<T = unknown>(text: string): T | null {
  const tryParse = (s: string): T | null => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  };
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== null) return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    const v = tryParse(fence[1]!.trim());
    if (v !== null) return v;
  }
  const first = trimmed.search(/[{[]/);
  if (first === -1) return null;
  const open = trimmed[first]!;
  const close = open === '{' ? '}' : ']';
  const last = trimmed.lastIndexOf(close);
  if (last <= first) return null;
  return tryParse(trimmed.slice(first, last + 1));
}
