import { MOODS, type Mood } from '../types';

/**
 * Incremental parser for a streamed reply.
 *
 * The model is asked to begin each reply with a mood tag such as `[curious]` and may
 * place further tags mid-reply. Tags drive the face and must never reach the voice,
 * so this parser removes them (and any stray markup) from the text stream, and
 * reports them as events positioned in the clean text.
 */

export type ReplyEvent =
  | { type: 'mood'; mood: Mood; at: number }
  | { type: 'text'; delta: string };

const MOOD_SET = new Set<string>(MOODS);
// Models occasionally pick a near-synonym; map the common ones instead of dropping them.
const MOOD_ALIASES: Record<string, Mood> = {
  happy: 'warm',
  friendly: 'warm',
  affectionate: 'warm',
  caring: 'warm',
  interested: 'curious',
  intrigued: 'curious',
  teasing: 'playful',
  cheeky: 'playful',
  laughing: 'amused',
  funny: 'amused',
  pensive: 'thoughtful',
  reflective: 'thoughtful',
  thinking: 'thoughtful',
  worried: 'concerned',
  empathetic: 'concerned',
  sympathetic: 'concerned',
  gentle: 'calm',
  relaxed: 'calm',
  soft: 'calm',
  enthusiastic: 'excited',
  delighted: 'excited',
  firm: 'serious',
  earnest: 'serious',
  honest: 'serious',
  sorry: 'sad',
  shocked: 'surprised',
  amazed: 'surprised',
};

export function toMood(raw: string): Mood | null {
  const key = raw.trim().toLowerCase().replace(/^mood\s*[:=]\s*/, '');
  if (MOOD_SET.has(key)) return key as Mood;
  return MOOD_ALIASES[key] ?? null;
}

const MAX_TAG = 28;

export class ReplyStreamParser {
  private pending = '';
  private emitted = 0;
  private started = false;

  /** Feed a chunk of model output; returns the events it completes. */
  push(chunk: string): ReplyEvent[] {
    this.pending += chunk;
    return this.drain(false);
  }

  /** Call once the stream ends to release anything held back. */
  end(): ReplyEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): ReplyEvent[] {
    const events: ReplyEvent[] = [];
    let out = '';
    const flushText = () => {
      if (!out) return;
      let text = sanitizeForSpeech(out);
      if (!this.started) {
        text = text.replace(/^\s+/, '');
        if (!text) {
          out = '';
          return;
        }
        this.started = true;
      }
      events.push({ type: 'text', delta: text });
      this.emitted += text.length;
      out = '';
    };

    let i = 0;
    const p = this.pending;
    while (i < p.length) {
      const ch = p[i]!;
      if (ch === '[') {
        const close = p.indexOf(']', i + 1);
        if (close === -1) {
          // Possibly an unfinished tag: hold it back unless it is clearly not one.
          if (!final && p.length - i <= MAX_TAG) break;
          out += ch;
          i++;
          continue;
        }
        const inner = p.slice(i + 1, close);
        const mood = inner.length <= MAX_TAG ? toMood(inner) : null;
        if (mood) {
          flushText();
          events.push({ type: 'mood', mood, at: this.emitted });
          i = close + 1;
          // swallow the single space that normally follows a tag
          if (p[i] === ' ') i++;
          continue;
        }
        if (/^[a-z][a-z _-]{1,22}$/i.test(inner)) {
          // A bracketed stage direction like [laughs]; never speak it.
          i = close + 1;
          if (p[i] === ' ') i++;
          continue;
        }
        out += ch;
        i++;
        continue;
      }
      out += ch;
      i++;
    }
    this.pending = p.slice(i);
    flushText();
    if (final && this.pending) {
      out = this.pending;
      this.pending = '';
      flushText();
    }
    return events;
  }
}

// Emoji and pictographs; the voice would either skip them or read their names.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;

/** Remove markup a voice would stumble over. Safe to apply to partial chunks. */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(EMOJI, '')
    .replace(/\*\*|__|~~|`+/g, '')
    .replace(/(^|\s)[*_](?=\S)/g, '$1')
    .replace(/(?<=\S)[*_](?=\s|$|[.,!?।])/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[ \t]{2,}/g, ' ');
}

/** Parse a complete reply in one go. */
export function parseReply(full: string): { text: string; mood: Mood; moods: Array<{ mood: Mood; at: number }> } {
  const parser = new ReplyStreamParser();
  const events = [...parser.push(full), ...parser.end()];
  let text = '';
  const moods: Array<{ mood: Mood; at: number }> = [];
  for (const e of events) {
    if (e.type === 'text') text += e.delta;
    else moods.push({ mood: e.mood, at: e.at });
  }
  text = text.replace(/\s+\n/g, '\n').trim();
  return { text, mood: moods[0]?.mood ?? guessMood(text), moods };
}

/** Cheap lexical fallback for models that forget the tag. */
export function guessMood(text: string): Mood {
  const t = text.toLowerCase();
  if (/\b(haha|ha ha|lol|funny|hilarious)\b|হাহা/.test(t)) return 'amused';
  if (/\b(sorry to hear|that's hard|that sounds (hard|rough|painful)|i'm sorry)\b|দুঃখ|কষ্ট/.test(t)) return 'concerned';
  if (/\b(wow|amazing|incredible|congrat|that's great|awesome)\b|দারুণ|অসাধারণ|বাহ/.test(t)) return 'excited';
  if (/\b(hmm|i wonder|not sure|let me think|interesting)\b|হুম/.test(t)) return 'thoughtful';
  if (/\?\s*$/.test(t)) return 'curious';
  return 'warm';
}
