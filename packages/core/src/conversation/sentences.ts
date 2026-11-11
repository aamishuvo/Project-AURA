/**
 * Splits streamed text into speakable sentences so speech can begin before the
 * model has finished writing. Understands English and Bangla punctuation.
 */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'approx', 'no', 'fig', 'inc', 'ltd', 'u.s', 'a.m', 'p.m',
]);

const TERMINATORS = '.!?।…';
const CLOSERS = '"\'”’)]';

export interface ChunkerOptions {
  /** Sentences shorter than this are merged with the next one. */
  minChars?: number;
  /** Sentences longer than this are split at a clause boundary. */
  maxChars?: number;
  /** Smaller minimum for the very first chunk so speech starts sooner. */
  firstMinChars?: number;
}

export class SentenceChunker {
  private buf = '';
  private count = 0;
  private readonly min: number;
  private readonly max: number;
  private readonly firstMin: number;

  constructor(opts: ChunkerOptions = {}) {
    this.min = opts.minChars ?? 24;
    this.max = opts.maxChars ?? 220;
    this.firstMin = opts.firstMinChars ?? 8;
  }

  push(delta: string): string[] {
    this.buf += delta;
    return this.extract(false);
  }

  flush(): string[] {
    const out = this.extract(true);
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) {
      out.push(rest);
      this.count++;
    }
    return out;
  }

  private extract(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const cut = this.findBoundary(final);
      if (cut === -1) break;
      const sentence = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut).replace(/^\s+/, '');
      if (sentence) {
        out.push(sentence);
        this.count++;
      }
    }
    return out;
  }

  private findBoundary(final: boolean): number {
    const b = this.buf;
    const min = this.count === 0 ? this.firstMin : this.min;
    for (let i = 0; i < b.length; i++) {
      const ch = b[i]!;
      if (ch === '\n') {
        if (b.slice(0, i).trim().length >= 1) return i + 1;
        continue;
      }
      if (!TERMINATORS.includes(ch)) continue;
      // absorb runs like "?!" or "..." and closing quotes
      let end = i + 1;
      while (end < b.length && (TERMINATORS.includes(b[end]!) || CLOSERS.includes(b[end]!))) end++;
      // need to see what follows to be sure the sentence really ended
      if (end >= b.length && !final) return -1;
      const next = b[end];
      if (next !== undefined && !/\s/.test(next)) {
        i = end - 1;
        continue; // "3.5", "example.com", "a.m."
      }
      if (ch === '.') {
        const before = b.slice(0, i);
        const word = before.match(/([A-Za-z.]+)$/)?.[1]?.toLowerCase() ?? '';
        if (ABBREVIATIONS.has(word)) {
          i = end - 1;
          continue;
        }
        if (/\b[A-Z]$/.test(before)) {
          i = end - 1;
          continue; // initials: "J. K. Rowling"
        }
      }
      if (b.slice(0, end).trim().length < min) {
        i = end - 1;
        continue;
      }
      return end;
    }
    // No terminator yet: break very long runs at a clause boundary so speech can start.
    if (b.length > this.max) {
      const window = b.slice(0, this.max);
      const m = /^[\s\S]*[,;:—–](?=\s)/.exec(window);
      if (m && m[0].length > this.max * 0.4) return m[0].length;
      const sp = window.lastIndexOf(' ');
      if (sp > this.max * 0.5) return sp;
    }
    return -1;
  }
}

/** Split a complete text into sentences. */
export function splitSentences(text: string, opts?: ChunkerOptions): string[] {
  const c = new SentenceChunker(opts);
  return [...c.push(text), ...c.flush()];
}
