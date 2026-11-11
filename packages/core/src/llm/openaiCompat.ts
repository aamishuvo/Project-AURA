import { LlmError, type LlmClient, type LlmRequest, type LlmResult, type LlmTier } from './types';
import { readSse } from '../util/sse';

/**
 * Client for any service that speaks the OpenAI Chat Completions streaming protocol:
 * Groq, Google Gemini (OpenAI-compatible endpoint), OpenRouter, OpenAI, Together,
 * a local Ollama or llama.cpp server, and so on. Uses only fetch, so the same code
 * runs on the server (key from the environment) and in the browser (the user's own
 * key in local mode).
 */

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  /** Model for spoken replies. */
  model: string;
  /** Per-tier overrides; any tier left out falls back to `model`. */
  models?: Partial<Record<LlmTier, string>>;
  /** Cheaper model for background memory work; defaults to the fast tier. */
  extractModel?: string;
  /** Name of the token-limit field. OpenAI's newest models want 'max_completion_tokens'. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Ask for a JSON object on extraction calls (most providers support it). */
  jsonMode?: boolean;
  temperature?: number | null;
  extraHeaders?: Record<string, string>;
  fetch?: typeof fetch;
  id?: string;
}

export function createOpenAiCompatLlm(opts: OpenAiCompatOptions): LlmClient {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = opts.baseUrl.replace(/\/+$/, '');
  const tokenParam = opts.maxTokensParam ?? 'max_tokens';

  return {
    id: opts.id ?? 'openai-compatible',
    async stream(req: LlmRequest, onDelta): Promise<LlmResult> {
      const model =
        req.purpose === 'extract'
          ? (opts.extractModel ?? opts.models?.fast ?? opts.model)
          : (opts.models?.[req.tier] ?? opts.model);
      const system = req.context ? `${req.system}\n\n${req.context}` : req.system;
      const body: Record<string, unknown> = {
        model,
        stream: true,
        messages: [{ role: 'system', content: system }, ...req.messages],
        [tokenParam]: req.maxOutputTokens ?? 1024,
      };
      if (opts.temperature !== null) body.temperature = req.purpose === 'extract' ? 0.2 : (opts.temperature ?? 0.8);
      if (req.purpose === 'extract' && opts.jsonMode !== false) body.response_format = { type: 'json_object' };

      let res: Response;
      try {
        res = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${opts.apiKey}`,
            ...opts.extraHeaders,
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        if (req.signal?.aborted) throw new LlmError('aborted', 'Request cancelled.');
        throw new LlmError('network', 'Could not reach the language model service.', { cause: err });
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        if (res.status === 401 || res.status === 403) throw new LlmError('unauthorized', `The model service rejected the API key (${res.status}).`);
        if (res.status === 429) throw new LlmError('rate_limited', 'The model service is rate limiting requests.');
        if (res.status === 413) throw new LlmError('too_large', 'The conversation is too long for this model.');
        if (res.status >= 500) throw new LlmError('unavailable', `The model service is unavailable (${res.status}).`);
        throw new LlmError('bad_response', `The model service returned ${res.status}: ${detail}`);
      }
      if (!res.body) throw new LlmError('bad_response', 'The model service returned no body.');

      let text = '';
      let truncated = false;
      let usage: LlmResult['usage'];
      try {
        for await (const msg of readSse(res.body, req.signal)) {
          if (msg.data === '[DONE]') break;
          let json: any;
          try {
            json = JSON.parse(msg.data);
          } catch {
            continue;
          }
          if (json.error) {
            throw new LlmError('unavailable', String(json.error.message ?? 'The model service reported an error.'), { partial: text });
          }
          const choice = json.choices?.[0];
          const delta: unknown = choice?.delta?.content;
          if (typeof delta === 'string' && delta) {
            text += delta;
            onDelta(delta);
          }
          if (choice?.finish_reason === 'length') truncated = true;
          if (json.usage) usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
        }
      } catch (err) {
        if (err instanceof LlmError) throw err;
        if (req.signal?.aborted) throw new LlmError('aborted', 'Request cancelled.', { partial: text });
        throw new LlmError('network', 'The connection dropped while the reply was arriving.', { partial: text, cause: err });
      }
      if (req.signal?.aborted) throw new LlmError('aborted', 'Request cancelled.', { partial: text });
      if (!text.trim()) throw new LlmError('bad_response', 'The model returned an empty reply.');
      return { text, truncated, model, usage };
    },
  };
}

/** Well-known OpenAI-compatible endpoints, so users only need to paste a key. */
export const OPENAI_COMPAT_PRESETS: Record<string, { label: string; baseUrl: string; model: string; extractModel?: string; keyHint: string; signupUrl: string; free: boolean }> = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    extractModel: 'llama-3.1-8b-instant',
    keyHint: 'gsk_…',
    signupUrl: 'https://console.groq.com/keys',
    free: true,
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    extractModel: 'gemini-2.5-flash-lite',
    keyHint: 'AIza…',
    signupUrl: 'https://aistudio.google.com/apikey',
    free: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    keyHint: 'sk-or-…',
    signupUrl: 'https://openrouter.ai/keys',
    free: false,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyHint: 'sk-…',
    signupUrl: 'https://platform.openai.com/api-keys',
    free: false,
  },
  custom: {
    label: 'Custom endpoint',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    keyHint: 'any value for local servers',
    signupUrl: '',
    free: true,
  },
};
