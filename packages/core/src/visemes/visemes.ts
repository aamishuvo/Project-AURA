/**
 * Text → mouth-shape timeline, for English and Bangla.
 *
 * Speech engines that hide their audio (the browser's speechSynthesis, the hosted
 * Claude voice) still need believable lip-sync. This module predicts the sequence of
 * visemes for a piece of text and how long each lasts; the avatar plays it against
 * the engine's clock (word-boundary or position events) and rescales it as real
 * durations become known.
 *
 * The rules are deliberately small: lip-sync needs the right *class* of mouth shape
 * at the right moment (closed lips for p/b/m, rounded for o/u, wide for i/e), not a
 * full pronunciation dictionary.
 */

export const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'] as const;
export type Viseme = (typeof VISEMES)[number];

export interface VisemeKey {
  /** Start time, ms from the beginning of the text. */
  t: number;
  /** Duration, ms. */
  d: number;
  v: Viseme;
  /** Articulation strength 0..1 (stressed vowels open wider). */
  w: number;
}

export interface WordSpan {
  start: number;
  end: number;
  charStart: number;
  charEnd: number;
}

export interface VisemeTimeline {
  keys: VisemeKey[];
  words: WordSpan[];
  /** Total length in ms, excluding the trailing pause. */
  duration: number;
}

type Phone = [v: Viseme, units: number, weight?: number];

const VOWELS: ReadonlySet<Viseme> = new Set(['aa', 'E', 'I', 'O', 'U']);

// ───────────────────────────── English ─────────────────────────────

const EN_RULES: Array<[string, Phone[]]> = [
  ['tion', [['CH', 0.6], ['aa', 0.6, 0.6], ['nn', 0.55]]],
  ['sion', [['CH', 0.6], ['aa', 0.6, 0.6], ['nn', 0.55]]],
  ['ough', [['O', 1.1]]],
  ['augh', [['aa', 1.0], ['FF', 0.55]]],
  ['eigh', [['E', 1.0], ['I', 0.4]]],
  ['igh', [['aa', 0.8], ['I', 0.5]]],
  ['tch', [['CH', 0.7]]],
  ['sch', [['SS', 0.5], ['kk', 0.45]]],
  ['eau', [['O', 1.1]]],
  ['th', [['TH', 0.6]]],
  ['sh', [['CH', 0.7]]],
  ['ch', [['CH', 0.7]]],
  ['ph', [['FF', 0.6]]],
  ['wh', [['U', 0.5]]],
  ['qu', [['kk', 0.45], ['U', 0.4]]],
  ['ck', [['kk', 0.5]]],
  ['ng', [['kk', 0.55]]],
  ['gh', []],
  ['kn', [['nn', 0.55]]],
  ['wr', [['RR', 0.55]]],
  ['oo', [['U', 1.1]]],
  ['ee', [['I', 1.1]]],
  ['ea', [['I', 1.05]]],
  ['ie', [['I', 1.0]]],
  ['ei', [['E', 1.0]]],
  ['ey', [['E', 0.9], ['I', 0.35]]],
  ['ai', [['E', 0.9], ['I', 0.35]]],
  ['ay', [['E', 0.9], ['I', 0.35]]],
  ['oa', [['O', 1.1]]],
  ['oi', [['O', 0.8], ['I', 0.45]]],
  ['oy', [['O', 0.8], ['I', 0.45]]],
  ['ou', [['aa', 0.7], ['U', 0.5]]],
  ['ow', [['aa', 0.7], ['U', 0.5]]],
  ['au', [['O', 1.1]]],
  ['aw', [['O', 1.1]]],
  ['ar', [['aa', 1.0], ['RR', 0.4]]],
  ['er', [['RR', 0.85]]],
  ['ir', [['RR', 0.85]]],
  ['ur', [['RR', 0.85]]],
  ['or', [['O', 0.9], ['RR', 0.4]]],
  ['ll', [['nn', 0.6]]],
  ['ss', [['SS', 0.7]]],
  ['tt', [['DD', 0.5]]],
  ['dd', [['DD', 0.5]]],
  ['pp', [['PP', 0.6]]],
  ['bb', [['PP', 0.6]]],
  ['mm', [['PP', 0.65]]],
  ['ff', [['FF', 0.6]]],
  ['nn', [['nn', 0.6]]],
  ['rr', [['RR', 0.6]]],
  ['zz', [['SS', 0.6]]],
  ['cc', [['kk', 0.5]]],
  ['gg', [['kk', 0.5]]],
];

const EN_SINGLE: Record<string, Phone[]> = {
  a: [['aa', 1.0]],
  e: [['E', 0.9]],
  i: [['I', 0.9]],
  o: [['O', 1.0]],
  u: [['aa', 0.8, 0.75]],
  y: [['I', 0.8]],
  p: [['PP', 0.55]],
  b: [['PP', 0.55]],
  m: [['PP', 0.6]],
  f: [['FF', 0.6]],
  v: [['FF', 0.55]],
  t: [['DD', 0.5]],
  d: [['DD', 0.5]],
  n: [['nn', 0.55]],
  l: [['nn', 0.55]],
  k: [['kk', 0.5]],
  g: [['kk', 0.5]],
  q: [['kk', 0.5]],
  c: [['kk', 0.5]],
  s: [['SS', 0.6]],
  z: [['SS', 0.6]],
  x: [['kk', 0.4], ['SS', 0.5]],
  r: [['RR', 0.55]],
  w: [['U', 0.5]],
  h: [['kk', 0.3, 0.4]],
  j: [['CH', 0.6]],
};

function englishPhones(word: string): Phone[] {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  const out: Phone[] = [];
  let i = 0;
  outer: while (i < w.length) {
    for (const [pat, phones] of EN_RULES) {
      if (w.startsWith(pat, i)) {
        out.push(...phones);
        i += pat.length;
        continue outer;
      }
    }
    const ch = w[i]!;
    const next = w[i + 1];
    if (ch === 'e' && i === w.length - 1 && !/[aeiou]/.test(w[i - 1] ?? '') && /[aeiouy]/.test(w.slice(0, i))) {
      i++; // silent final e: "make", "time" (but not "the", "she", "me")
      continue;
    }
    if (ch === 'c' && next && 'eiy'.includes(next)) {
      out.push(['SS', 0.6]);
    } else if (ch === 'y' && i === 0) {
      out.push(['I', 0.4, 0.7]);
    } else if (ch === 'u' && w[i + 2] === 'e' && i + 2 === w.length - 1) {
      out.push(['U', 1.0]); // "rude", "tune"
    } else {
      out.push(...(EN_SINGLE[ch] ?? []));
    }
    i++;
  }
  return out;
}

// ───────────────────────────── Bangla ─────────────────────────────

const BN_CONSONANTS: Record<string, Viseme> = {
  'ক': 'kk', 'খ': 'kk', 'গ': 'kk', 'ঘ': 'kk', 'ঙ': 'kk',
  'চ': 'CH', 'ছ': 'CH', 'জ': 'CH', 'ঝ': 'CH', 'ঞ': 'nn',
  'ট': 'DD', 'ঠ': 'DD', 'ড': 'DD', 'ঢ': 'DD', 'ণ': 'nn',
  'ত': 'DD', 'থ': 'DD', 'দ': 'DD', 'ধ': 'DD', 'ন': 'nn',
  'প': 'PP', 'ফ': 'FF', 'ব': 'PP', 'ভ': 'PP', 'ম': 'PP',
  'য': 'CH', 'র': 'RR', 'ল': 'nn',
  'শ': 'SS', 'ষ': 'SS', 'স': 'SS', 'হ': 'kk',
  'ড়': 'RR', 'ঢ়': 'RR', 'য়': 'I', 'ৎ': 'DD',
};

const BN_VOWEL_SIGNS: Record<string, Phone[]> = {
  'া': [['aa', 1.0]],
  'ি': [['I', 0.85]],
  'ী': [['I', 1.0]],
  'ু': [['U', 0.85]],
  'ূ': [['U', 1.0]],
  'ৃ': [['RR', 0.5], ['I', 0.5]],
  'ে': [['E', 0.95]],
  'ৈ': [['O', 0.7], ['I', 0.45]],
  'ো': [['O', 1.0]],
  'ৌ': [['O', 0.7], ['U', 0.45]],
};

const BN_VOWELS: Record<string, Phone[]> = {
  'অ': [['O', 0.9]],
  'আ': [['aa', 1.0]],
  'ই': [['I', 0.85]],
  'ঈ': [['I', 1.0]],
  'উ': [['U', 0.85]],
  'ঊ': [['U', 1.0]],
  'ঋ': [['RR', 0.5], ['I', 0.5]],
  'এ': [['E', 0.95]],
  'ঐ': [['O', 0.7], ['I', 0.45]],
  'ও': [['O', 1.0]],
  'ঔ': [['O', 0.7], ['U', 0.45]],
};

const HASANTA = '্';

function banglaPhones(word: string): Phone[] {
  const chars = Array.from(word.normalize('NFC'));
  const out: Phone[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const next = chars[i + 1];
    const cons = BN_CONSONANTS[ch];
    if (cons) {
      const weak = ch === 'হ' || ch === 'য়';
      out.push([cons, weak ? 0.4 : 0.5, weak ? 0.6 : 0.85]);
      if (next === HASANTA) {
        i++; // conjunct: no vowel between these consonants
        continue;
      }
      if (next && BN_VOWEL_SIGNS[next]) continue; // the sign supplies the vowel
      const isLast = i === chars.length - 1 || !chars.slice(i + 1).some((c) => BN_CONSONANTS[c] || BN_VOWELS[c] || BN_VOWEL_SIGNS[c]);
      // inherent vowel (অ): pronounced inside a word, usually silent at its end
      if (!isLast || chars.length <= 2) out.push(['O', 0.65, 0.7]);
      continue;
    }
    if (BN_VOWEL_SIGNS[ch]) {
      out.push(...BN_VOWEL_SIGNS[ch]!);
      continue;
    }
    if (BN_VOWELS[ch]) {
      out.push(...BN_VOWELS[ch]!);
      continue;
    }
    if (ch === 'ং') out.push(['kk', 0.45, 0.6]);
    // candrabindu, visarga, ZWJ/ZWNJ and anything else add no mouth shape
  }
  return out;
}

// ───────────────────────────── timeline ─────────────────────────────

const DIGIT_SHAPES: Viseme[] = ['E', 'aa', 'U', 'I', 'O', 'aa', 'I', 'E', 'E', 'aa'];
const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';

function numberPhones(token: string): Phone[] {
  const out: Phone[] = [];
  for (const ch of token) {
    let d = ch.charCodeAt(0) - 48;
    if (d < 0 || d > 9) d = BENGALI_DIGITS.indexOf(ch);
    if (d < 0) continue;
    out.push(['DD', 0.4, 0.7], [DIGIT_SHAPES[d]!, 1.0], ['nn', 0.4, 0.6]);
  }
  return out;
}

const WORD_GAP = 0.18;
const PAUSE_UNITS: Record<string, number> = {
  ',': 2.2, ';': 2.4, ':': 2.2, '—': 2.4, '–': 2.2, '-': 0,
  '.': 3.6, '!': 3.6, '?': 3.8, '।': 3.6, '…': 4.2, '\n': 3.6,
};

export interface TimelineOptions {
  /** Milliseconds per timing unit; ~95 matches a natural English voice at rate 1. */
  unitMs?: number;
}

export const DEFAULT_UNIT_MS = 95;

export function textToVisemes(text: string, opts: TimelineOptions = {}): VisemeTimeline {
  const unit = opts.unitMs ?? DEFAULT_UNIT_MS;
  const keys: VisemeKey[] = [];
  const words: WordSpan[] = [];
  let t = 0;
  let lastSpeechEnd = 0;
  const tokenRe = /([\p{L}\p{M}‌‍'’]+)|([\p{N}]+)|([,;:—–.!?।…\n])/gu;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text))) {
    const [token, word, number, punct] = m;
    if (punct) {
      const pause = (PAUSE_UNITS[punct] ?? 0) * unit;
      if (pause > 0) {
        keys.push({ t, d: pause, v: 'sil', w: 0 });
        t += pause;
      }
      continue;
    }
    const phones = number
      ? numberPhones(number)
      : /[ঀ-৿]/.test(word!)
        ? banglaPhones(word!)
        : englishPhones(word!);
    if (phones.length === 0) continue;
    const start = t;
    let firstVowel = true;
    for (const [v, units, weight] of phones) {
      let w = weight ?? (VOWELS.has(v) ? 0.9 : 0.85);
      if (VOWELS.has(v)) {
        if (firstVowel) w = Math.min(1, w + 0.1); // light stress on the first syllable
        firstVowel = false;
      }
      const d = units * unit;
      keys.push({ t, d, v, w });
      t += d;
    }
    words.push({ start, end: t, charStart: m.index, charEnd: m.index + token.length });
    lastSpeechEnd = t;
    t += WORD_GAP * unit;
  }
  return { keys, words, duration: lastSpeechEnd };
}

/** Stretch or compress a timeline so it spans `duration` ms. */
export function fitTimeline(tl: VisemeTimeline, duration: number): VisemeTimeline {
  if (tl.duration <= 0 || duration <= 0) return tl;
  const k = duration / tl.duration;
  return {
    keys: tl.keys.map((key) => ({ ...key, t: key.t * k, d: key.d * k })),
    words: tl.words.map((w) => ({ ...w, start: w.start * k, end: w.end * k })),
    duration,
  };
}

export interface VisemeSample {
  v: Viseme;
  w: number;
  /** Index into `timeline.words` of the word being spoken, or -1. */
  word: number;
  done: boolean;
}

/** What the mouth should be doing at time `ms`. Keys are sorted, so this is a binary search. */
export function sampleVisemes(tl: VisemeTimeline, ms: number): VisemeSample {
  if (ms < 0 || tl.keys.length === 0) return { v: 'sil', w: 0, word: -1, done: tl.keys.length === 0 };
  if (ms >= tl.duration) return { v: 'sil', w: 0, word: -1, done: true };
  let lo = 0;
  let hi = tl.keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl.keys[mid]!.t <= ms) lo = mid;
    else hi = mid - 1;
  }
  const key = tl.keys[lo]!;
  let word = -1;
  let a = 0;
  let b = tl.words.length - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    const span = tl.words[mid]!;
    if (ms < span.start) b = mid - 1;
    else if (ms >= span.end) a = mid + 1;
    else {
      word = mid;
      break;
    }
  }
  if (ms > key.t + key.d) return { v: 'sil', w: 0, word, done: false };
  return { v: key.v, w: key.w, word, done: false };
}
