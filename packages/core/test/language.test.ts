import { describe, expect, it } from 'vitest';
import {
  ReplyStreamParser,
  SentenceChunker,
  compilePersona,
  DEFAULT_PERSONA,
  PERSONA_PRESETS,
  detectLanguage,
  fitTimeline,
  guessMood,
  looksBanglish,
  normalizePersona,
  normalizeSettings,
  parseReply,
  relativeTime,
  sampleVisemes,
  speechLang,
  splitSentences,
  textToVisemes,
  tokenize,
  type ReplyEvent,
} from '../src';

const feed = (chunks: string[]) => {
  const p = new ReplyStreamParser();
  const events: ReplyEvent[] = [];
  for (const c of chunks) events.push(...p.push(c));
  events.push(...p.end());
  return {
    text: events.filter((e) => e.type === 'text').map((e) => (e as any).delta).join(''),
    moods: events.filter((e) => e.type === 'mood').map((e) => (e as any).mood),
    events,
  };
};

describe('reply stream parser', () => {
  it('extracts the leading mood tag and never emits it as text', () => {
    const r = feed(['[curious] Wait, you built that in a weekend?']);
    expect(r.moods).toEqual(['curious']);
    expect(r.text).toBe('Wait, you built that in a weekend?');
  });

  it('handles a tag split across stream chunks', () => {
    const r = feed(['[cu', 'rio', 'us] Hel', 'lo there.']);
    expect(r.moods).toEqual(['curious']);
    expect(r.text).toBe('Hello there.');
  });

  it('reports mid-reply mood changes at the right text position', () => {
    const r = feed(['[amused] Ha, okay. ', '[serious] But honestly, that worries me.']);
    expect(r.moods).toEqual(['amused', 'serious']);
    expect(r.text).toBe('Ha, okay. But honestly, that worries me.');
    const second = r.events.filter((e) => e.type === 'mood')[1] as Extract<ReplyEvent, { type: 'mood' }>;
    expect(second.at).toBe('Ha, okay. '.length);
  });

  it('maps near-synonyms and drops stage directions', () => {
    const r = feed(['[happy] Good to see you. [laughs] Really.']);
    expect(r.moods).toEqual(['warm']);
    expect(r.text).toBe('Good to see you. Really.');
  });

  it('keeps ordinary bracketed text and works without any tag', () => {
    const r = feed(['The answer is [42] today.']);
    expect(r.moods).toEqual([]);
    expect(r.text).toBe('The answer is [42] today.');
  });

  it('strips markdown and emoji that a voice would stumble on', () => {
    const { text } = parseReply('[warm] **Sure** thing 😊 — `code` and _emphasis_ here.');
    expect(text).toBe('Sure thing — code and emphasis here.');
  });

  it('never loses text when a bracket is left open', () => {
    const r = feed(['[warm] I meant [the other one', ' entirely']);
    expect(r.text).toBe('I meant [the other one entirely');
  });

  it('guesses a mood when the model forgets the tag', () => {
    expect(parseReply('What happened next?').mood).toBe('curious');
    expect(guessMood("I'm sorry to hear that.")).toBe('concerned');
    expect(parseReply('[excited] Yes!').mood).toBe('excited');
  });

  it('parses Bangla replies', () => {
    const r = feed(['[warm] হ্যালো, ', 'কেমন আছ?']);
    expect(r.moods).toEqual(['warm']);
    expect(r.text).toBe('হ্যালো, কেমন আছ?');
  });
});

describe('sentence chunker', () => {
  it('releases a sentence only once it is complete', () => {
    const c = new SentenceChunker();
    expect(c.push('Hello there, how are')).toEqual([]);
    expect(c.push(' you today? I am')).toEqual(['Hello there, how are you today?']);
    expect(c.flush()).toEqual(['I am']);
  });

  it('does not split on abbreviations, initials or decimals', () => {
    expect(splitSentences('Dr. Rahman paid 3.5 dollars at example.com today. Then he left.')).toEqual([
      'Dr. Rahman paid 3.5 dollars at example.com today.',
      'Then he left.',
    ]);
  });

  it('splits Bangla on the danda', () => {
    expect(splitSentences('আমি ভালো আছি। তুমি কেমন আছ? চলো কথা বলি।', { minChars: 4 })).toEqual([
      'আমি ভালো আছি।',
      'তুমি কেমন আছ?',
      'চলো কথা বলি।',
    ]);
  });

  it('merges very short fragments into the next sentence', () => {
    expect(splitSentences('This is the opening sentence. Yes. Okay. That makes a lot of sense to me now.')).toEqual([
      'This is the opening sentence.',
      'Yes. Okay. That makes a lot of sense to me now.',
    ]);
  });

  it('lets the first chunk out early so speech can start', () => {
    const c = new SentenceChunker();
    expect(c.push('Oh nice! That is ')).toEqual(['Oh nice!']);
  });

  it('breaks a long unpunctuated run at a clause boundary', () => {
    const long = 'so the thing about this plan is that it depends on three different people all agreeing at once, ' +
      'which in my experience almost never happens unless someone is pushing really hard for it and following up every single day until it is done';
    const out = splitSentences(long, { maxChars: 120 });
    expect(out.length).toBeGreaterThan(1);
    expect(out.join(' ')).toBe(long);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(121);
  });

  it('keeps runs of terminators and closing quotes together', () => {
    expect(splitSentences('She said "really?!" Then she laughed out loud.', { minChars: 4 })).toEqual(['She said "really?!"', 'Then she laughed out loud.']);
  });
});

describe('language detection', () => {
  it('classifies English, Bangla and mixed speech', () => {
    expect(detectLanguage('How are you doing today?')).toBe('en');
    expect(detectLanguage('আমি আজ খুব ভালো আছি')).toBe('bn');
    expect(detectLanguage('আমি একটা meeting এ যাচ্ছি, later কথা বলব')).toBe('mixed');
  });

  it('recognises Bangla typed in English letters', () => {
    expect(looksBanglish('ami bhalo achi, tumi kemon acho')).toBe(true);
    expect(looksBanglish('I am fine, how are you')).toBe(false);
    expect(detectLanguage('ami ekhon kaj korchi')).toBe('mixed');
  });

  it('picks the voice language per sentence', () => {
    expect(speechLang('Let me think about that.')).toBe('en');
    expect(speechLang('আমার project টা almost done')).toBe('bn');
  });

  it('tokenizes both scripts and drops stop words', () => {
    expect(tokenize('I am building a robot for my thesis')).toEqual(['build', 'robot', 'thesis']);
    expect(tokenize('আমি ঢাকায় থাকি এবং গান ভালোবাসি')).toEqual(['ঢাকায়', 'থাকি', 'গান', 'ভালোবাসি']);
  });

  it('describes elapsed time the way a person would', () => {
    const now = new Date('2026-11-11T12:00:00Z').getTime();
    expect(relativeTime(now - 30_000, now)).toBe('moments ago');
    expect(relativeTime(now - 26 * 3600_000, now)).toBe('yesterday');
    expect(relativeTime(now - 3 * 86400_000, now)).toBe('3 days ago');
  });
});

describe('personality engine', () => {
  const compiled = compilePersona(DEFAULT_PERSONA, { language: 'auto' });

  it('is deterministic, so providers can cache the prompt prefix', () => {
    expect(compilePersona(DEFAULT_PERSONA, { language: 'auto' })).toBe(compiled);
    expect(compiled).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('always carries the honesty rules about feelings and consciousness', () => {
    for (const preset of PERSONA_PRESETS) {
      const text = compilePersona(preset.config, { language: 'auto' });
      expect(text).toContain('You are an AI.');
      expect(text).toContain('You do not claim to have human feelings');
      expect(text).toContain('you do not know what, if anything, it is like to be you');
      expect(text).toContain('Never invent facts');
    }
  });

  it('asks for disagreement, not agreeableness', () => {
    expect(compiled).toContain('Do not agree just to be agreeable');
  });

  it('changes character when traits change, without code changes', () => {
    const blunt = compilePersona({ ...DEFAULT_PERSONA, traits: { ...DEFAULT_PERSONA.traits, candor: 0.95, humor: 0.05 } }, { language: 'auto' });
    const gentle = compilePersona({ ...DEFAULT_PERSONA, traits: { ...DEFAULT_PERSONA.traits, candor: 0.1, humor: 0.9 } }, { language: 'auto' });
    expect(blunt).toContain('You are candid.');
    expect(blunt).toContain('You are mostly earnest.');
    expect(gentle).toContain('You lean supportive.');
    expect(gentle).toContain('You are funny');
  });

  it('adapts language rules to the chosen mode', () => {
    expect(compilePersona(DEFAULT_PERSONA, { language: 'bn' })).toContain('Speak Bangla.');
    expect(compilePersona(DEFAULT_PERSONA, { language: 'mixed' })).toContain('mostly Bangla, with English words');
    expect(compilePersona(DEFAULT_PERSONA, { language: 'en' })).toContain('Speak English.');
    expect(compiled).toContain('Always write Bangla in Bangla script');
  });

  it('appends personal instructions but keeps them below the honesty rules', () => {
    const text = compilePersona({ ...DEFAULT_PERSONA, customInstructions: 'Call me boss.' }, { language: 'auto' });
    expect(text).toContain('Call me boss.');
    expect(text).toContain('They never override the honesty rules above.');
  });

  it('repairs invalid persona data instead of trusting it', () => {
    const p = normalizePersona({ name: '  ', traits: { warmth: 7, humor: -3, candor: 'x' }, interests: ['a', 5, ''], banglaAddress: 'tui', customInstructions: 'x'.repeat(5000) });
    expect(p.name).toBe('AURA');
    expect(p.traits.warmth).toBe(1);
    expect(p.traits.humor).toBe(0);
    expect(p.traits.candor).toBe(DEFAULT_PERSONA.traits.candor);
    expect(p.interests).toEqual(['a']);
    expect(p.banglaAddress).toBe('tumi');
    expect(p.customInstructions.length).toBe(1500);
  });

  it('repairs invalid settings', () => {
    const s = normalizeSettings({ language: 'klingon', conversation: { endpointMs: 5 }, voice: { rate: 9 } });
    expect(s.language).toBe('auto');
    expect(s.conversation.endpointMs).toBe(400);
    expect(s.voice.rate).toBe(1.5);
    expect(s.memory.enabled).toBe(true);
  });
});

describe('viseme timelines', () => {
  const shapes = (text: string) => textToVisemes(text).keys.filter((k) => k.v !== 'sil').map((k) => k.v);

  it('closes the lips for p, b and m', () => {
    expect(shapes('mama')).toEqual(['PP', 'aa', 'PP', 'aa']);
    expect(shapes('baby')[0]).toBe('PP');
  });

  it('handles English digraphs and silent letters', () => {
    expect(shapes('the')).toEqual(['TH', 'E']);
    expect(shapes('make')).toEqual(['PP', 'aa', 'kk']);
    expect(shapes('ship')).toEqual(['CH', 'I', 'PP']);
    expect(shapes('food')).toEqual(['FF', 'U', 'DD']);
  });

  it('maps Bangla letters, vowel signs and conjuncts', () => {
    expect(shapes('আমার')).toEqual(['aa', 'PP', 'aa', 'RR']);
    expect(shapes('তুমি')).toEqual(['DD', 'U', 'PP', 'I']);
    // conjunct ন্ত has no vowel between its consonants
    expect(shapes('শান্তি')).toEqual(['SS', 'aa', 'nn', 'DD', 'I']);
    // inherent vowel inside a word, silent at the end
    expect(shapes('কলম')).toEqual(['kk', 'O', 'nn', 'O', 'PP']);
  });

  it('produces ordered, gap-free timing with pauses at punctuation', () => {
    const tl = textToVisemes('Hello, how are you? আমি ভালো আছি।');
    let prevEnd = 0;
    for (const k of tl.keys) {
      expect(k.t).toBeGreaterThanOrEqual(prevEnd - 1e-6);
      prevEnd = k.t + k.d;
    }
    expect(tl.keys.some((k) => k.v === 'sil' && k.d > 150)).toBe(true);
    expect(tl.words).toHaveLength(7);
    expect('Hello, how are you? আমি ভালো আছি।'.slice(tl.words[0]!.charStart, tl.words[0]!.charEnd)).toBe('Hello');
  });

  it('samples the mouth shape and current word at a point in time', () => {
    const tl = textToVisemes('mama papa');
    expect(sampleVisemes(tl, 0).v).toBe('PP');
    expect(sampleVisemes(tl, tl.keys[1]!.t + 1).v).toBe('aa');
    expect(sampleVisemes(tl, tl.words[1]!.start + 1).word).toBe(1);
    expect(sampleVisemes(tl, tl.duration + 10)).toMatchObject({ v: 'sil', done: true });
  });

  it('rescales to a measured duration', () => {
    const tl = textToVisemes('This is a test of the timing model.');
    const fitted = fitTimeline(tl, 3000);
    expect(fitted.duration).toBe(3000);
    expect(fitted.words.at(-1)!.end).toBeCloseTo(3000, 3);
    expect(fitted.keys.length).toBe(tl.keys.length);
  });

  it('gives speech a plausible duration', () => {
    const tl = textToVisemes('Hello, how are you doing today?');
    expect(tl.duration).toBeGreaterThan(1200);
    expect(tl.duration).toBeLessThan(2600);
  });
});
