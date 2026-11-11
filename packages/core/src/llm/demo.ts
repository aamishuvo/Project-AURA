import { CURATOR_MARKER } from '../memory/memory';
import { detectLanguage, tokenize } from '../util/text';
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from './types';

/**
 * A scripted stand-in for a language model.
 *
 * It is NOT intelligent and never pretends to be: it answers from simple rules over
 * exactly the same prompt a real model would receive. That makes it useful for two
 * things: (1) deterministic automated tests of the whole pipeline — context
 * building, memory, streaming, interruption — and (2) a clearly labelled demo mode
 * so the face, voice and conversation loop can be tried before a model is connected.
 */

export interface DemoLlmOptions {
  /** Delay before the first chunk, ms. */
  latencyMs?: number;
  /** Delay between streamed chunks, ms. */
  chunkMs?: number;
  /** Observe every request (tests assert on the prompt that would reach a model). */
  onRequest?: (req: LlmRequest) => void;
  /** Throw this error on the next N requests (failure-recovery tests). */
  failNext?: { count: number; error: LlmError };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmError('aborted', 'Request cancelled.'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new LlmError('aborted', 'Request cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function createDemoLlm(opts: DemoLlmOptions = {}): LlmClient & { options: DemoLlmOptions } {
  return {
    id: 'demo',
    options: opts,
    async stream(req: LlmRequest, onDelta): Promise<LlmResult> {
      opts.onRequest?.(req);
      if (opts.failNext && opts.failNext.count > 0) {
        opts.failNext.count--;
        throw opts.failNext.error;
      }
      const full = req.system.startsWith(CURATOR_MARKER) ? curate(req) : chat(req);
      if (req.purpose === 'extract') {
        await sleep(opts.latencyMs ?? 0, req.signal);
        onDelta(full);
        return { text: full, model: 'demo' };
      }
      await sleep(opts.latencyMs ?? 120, req.signal);
      // stream in word-sized pieces, like a real model
      const pieces = full.match(/\S+\s*/g) ?? [full];
      let text = '';
      for (const piece of pieces) {
        if (req.signal?.aborted) throw new LlmError('aborted', 'Request cancelled.', { partial: text });
        text += piece;
        onDelta(piece);
        const wait = opts.chunkMs ?? 18;
        if (wait > 0) await sleep(wait, req.signal);
      }
      return { text, model: 'demo' };
    },
  };
}

// ───────────────────────────── scripted conversation ─────────────────────────────

function findName(context: string): string | null {
  return (
    /They asked to be called ([^.\n]+)\./.exec(context)?.[1]?.trim() ??
    /Their name is ([^.\n(]+?)[.(\n]/.exec(context)?.[1]?.trim() ??
    null
  );
}

/** A real model reads the name straight from the conversation; the script does the same. */
function nameFromMessages(userTexts: string[]): string | null {
  for (let i = userTexts.length - 1; i >= 0; i--) {
    const t = userTexts[i]!;
    const m = /(?:my name is|call me)\s+([\p{L}'-]+)/iu.exec(t) ?? /আমার নাম\s+([^\s।,.!?]+)/u.exec(t);
    if (m) return m[1]!;
  }
  return null;
}

function memoryLines(context: string): string[] {
  const section = /# What you remember about them\n([\s\S]*?)(?:\n\n#|$)/.exec(context)?.[1] ?? '';
  return section
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).replace(/\s*\([^)]*\)\s*$/, '').trim());
}

function chat(req: LlmRequest): string {
  const context = req.context ?? '';
  const last = req.messages[req.messages.length - 1]?.content ?? '';
  const userTurns = req.messages.filter((m) => m.role === 'user' && !m.content.startsWith('('));
  const previousUser = userTurns.length >= 2 ? userTurns[userTurns.length - 2]!.content : null;
  const name = findName(context) ?? nameFromMessages(req.messages.map((m) => (m.role === 'user' ? m.content : '')));
  const forcedBangla = /- Speak Bangla\./.test(req.system) || /mostly Bangla/.test(req.system);
  const lang = last.startsWith('(') ? (forcedBangla ? 'bn' : 'en') : detectLanguage(last);
  const bn = lang !== 'en' || forcedBangla;
  const text = last.toLowerCase();

  if (last.startsWith('(')) {
    if (/first time/.test(last)) {
      return bn
        ? '[warm] হ্যালো, আমি AURA। তোমাকে কী নামে ডাকব?'
        : "[warm] Hi, I'm AURA. What should I call you?";
    }
    if (/stepped away/.test(last)) return bn ? '[warm] ফিরে এসেছ। কোথায় ছিলাম আমরা?' : '[warm] Welcome back. Where were we?';
    const projects = memoryLines(context).filter((l) => /working on|building|writing|preparing/i.test(l));
    if (projects.length) {
      return bn
        ? `[curious] আরে${name ? ` ${name}` : ''}, কেমন আছ? ওই কাজটা কতদূর এগোল?`
        : `[curious] Hey${name ? ` ${name}` : ''}. How is it going with what you were working on?`;
    }
    return bn
      ? `[warm] আরে${name ? ` ${name}` : ''}, কেমন আছ আজ?`
      : `[warm] Hey${name ? ` ${name}` : ''}, good to hear you. What's on your mind?`;
  }

  if (/what('?s| is) my name|who am i|do you (know|remember) my name|আমার নাম (কী|কি)/.test(text)) {
    if (name) return bn ? `[playful] তোমার নাম ${name}। ভুলিনি।` : `[playful] You're ${name}. I hadn't forgotten.`;
    return bn ? '[curious] তুমি এখনো বলোনি তো। কী নামে ডাকব?' : "[curious] I don't think you've told me yet. What should I call you?";
  }
  if (/what do you (remember|know) about me|আমার সম্পর্কে কী (মনে|জানো)/.test(text)) {
    const lines = memoryLines(context);
    if (!lines.length) return bn ? '[thoughtful] এখনো তেমন কিছু না। আমরা তো সবে শুরু করলাম।' : "[thoughtful] Not much yet. We're only getting started.";
    return `[thoughtful] ${bn ? 'এটুকু মনে আছে:' : "Here's what I have:"} ${lines.slice(0, 6).join(' ')}`;
  }
  if (/what did i (just )?say|what were we (talking|just talking) about|আমি (কী|কি) বললাম/.test(text)) {
    if (previousUser) return bn ? `[thoughtful] তুমি বলেছিলে: "${previousUser}"` : `[thoughtful] You said: "${previousUser}"`;
    return bn ? '[curious] এটাই তো তোমার প্রথম কথা।' : "[curious] That's the first thing you've said so far.";
  }
  if (/are you (conscious|alive|human|a person|real|sentient)|do you (have|feel) (feelings|emotions)|তোমার কি অনুভূতি/.test(text)) {
    return bn
      ? '[thoughtful] সত্যি বলতে, আমি জানি না আমার ভেতরে আদৌ কিছু অনুভূত হয় কি না। আমি একটা AI, আর এ নিয়ে ভান করব না।'
      : "[thoughtful] Honestly, I don't know what, if anything, it's like to be me. I'm an AI, and I won't pretend either way.";
  }
  if (/\b(remember|don'?t forget)\b|মনে রেখো|মনে রাখো/.test(text)) {
    return bn ? '[warm] ঠিক আছে, মনে রাখলাম।' : "[warm] Got it. I'll remember that.";
  }
  if (/\bforget\b|ভুলে যাও/.test(text)) {
    return bn ? '[calm] ঠিক আছে, ওটা ভুলে গেলাম।' : "[calm] Okay. Consider it forgotten.";
  }
  if (/^(hi|hello|hey|hola|হাই|হ্যালো|আসসালামু)/.test(text)) {
    return bn ? `[warm] হ্যালো${name ? ` ${name}` : ''}! কী খবর?` : `[warm] Hello${name ? ` ${name}` : ''}! What's going on?`;
  }
  if (/\b(sad|tired|stressed|anxious|lonely|upset)\b|মন খারাপ|ক্লান্ত/.test(text)) {
    return bn ? '[concerned] শুনে খারাপ লাগছে। কী হয়েছে, বলবে?' : "[concerned] That sounds heavy. Do you want to tell me what's going on?";
  }
  if (/my name is|call me|আমার নাম/.test(text)) {
    const said = /(?:my name is|call me)\s+([\p{L}'-]+)/iu.exec(last)?.[1] ?? /আমার নাম\s+([^\s।,.!?]+)/u.exec(last)?.[1];
    return bn ? `[warm] ${said ?? ''}, সুন্দর নাম। আজ কী নিয়ে কথা বলবে?` : `[warm] ${said ?? 'Nice'}. Good to meet you. What would you like to talk about?`;
  }
  const words = tokenize(last);
  const topic = words.sort((a, b) => b.length - a.length)[0];
  if (/\?\s*$/.test(last)) {
    return bn
      ? '[thoughtful] ভালো প্রশ্ন। আমি এখন ডেমো মোডে আছি, তাই ঠিকঠাক ভাবতে পারছি না। সেটিংসে একটা ভাষা-মডেল যুক্ত করলে আসল উত্তর দিতে পারব।'
      : "[thoughtful] Good question. I'm running in demo mode, so I can't really think it through. Connect a language model in settings and ask me again.";
  }
  if (topic) {
    return bn ? `[curious] ${topic}, তাই? আরেকটু বলো তো।` : `[curious] ${topic[0]!.toUpperCase()}${topic.slice(1)}, huh? Tell me more about that.`;
  }
  return bn ? '[curious] হুম, তারপর?' : '[curious] Mm. Go on.';
}

// ───────────────────────────── scripted memory curator ─────────────────────────────

interface Existing {
  alias: string;
  kind: string;
  content: string;
}

function curate(req: LlmRequest): string {
  const input = req.messages[req.messages.length - 1]?.content ?? '';
  const existing: Existing[] = [];
  for (const m of input.matchAll(/^\[(m\d+)\] \(([a-z]+)[^)]*\) (.+)$/gm)) existing.push({ alias: m[1]!, kind: m[2]!, content: m[3]! });
  const transcript = input.split('Newest part of the conversation:')[1] ?? '';
  const said = [...transcript.matchAll(/^Them: (.+)$/gm)].map((m) => m[1]!);
  const learn = !/Memory learning is switched off/.test(req.system);
  const ops: unknown[] = [];
  const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/[.!?।\s]+$/, '').trim();
  const find = (re: RegExp) => existing.find((e) => re.test(e.content));
  const upsert = (re: RegExp, kind: string, content: string, importance: number, explicit = false) => {
    const prior = find(re);
    if (prior) {
      if (prior.content !== content) ops.push({ op: 'update', id: prior.alias, content, reason: 'new information replaces the old' });
    } else ops.push({ op: 'add', kind, content, importance, sensitive: false, explicit });
  };

  if (learn) {
    for (const line of said) {
      let m: RegExpExecArray | null;
      if ((m = /\bforget (?:that |about |what i said about )?(.+)/i.exec(line)) || (m = /(.+?)\s*ভুলে যাও/.exec(line))) {
        const target = tokenize(m[1]!);
        for (const e of existing) {
          const overlap = tokenize(e.content).filter((t) => target.includes(t)).length;
          if (overlap >= 1 || /everything|সব/.test(m[1]!)) ops.push({ op: 'delete', id: e.alias, reason: 'they asked to forget this' });
        }
        continue;
      }
      if ((m = /(?:my name is|call me)\s+([\p{L}'-]+)/iu.exec(line)) || (m = /আমার নাম\s+([^\s।,.!?]+)/u.exec(line))) {
        upsert(/name is/i, 'identity', `Their name is ${clean(m[1]!)}.`, 0.95);
      }
      if ((m = /\bi (?:have )?(?:just )?moved to ([^.,!?]+)/i.exec(line)) || (m = /\bi(?:'m| am)? (?:live|living|based) in ([^.,!?]+)/i.exec(line)) || (m = /\bi live in ([^.,!?]+)/i.exec(line))) {
        upsert(/\blive in\b/i, 'identity', `They live in ${clean(m[1]!)}.`, 0.8);
      }
      if ((m = /\bi(?:'m| am) (?:working on|building|writing|making|preparing(?: for)?) ([^.,!?]+)/i.exec(line))) {
        ops.push({ op: 'add', kind: 'project', content: `They are working on ${clean(m[1]!)}.`, importance: 0.7, sensitive: false, explicit: false });
      }
      if ((m = /\bi (?:really |absolutely )?(?:like|love|enjoy|prefer) ([^.,!?]+)/i.exec(line))) {
        ops.push({ op: 'add', kind: 'preference', content: `They like ${clean(m[1]!)}.`, importance: 0.6, sensitive: false, explicit: false });
      }
      if ((m = /আমি\s+(.+?)\s+(?:খুব\s+)?(?:পছন্দ করি|ভালোবাসি)/u.exec(line))) {
        ops.push({ op: 'add', kind: 'preference', content: `They like ${clean(m[1]!)}.`, importance: 0.6, sensitive: false, explicit: false });
      }
      if ((m = /\bi (?:hate|dislike|can'?t stand|don'?t like) ([^.,!?]+)/i.exec(line))) {
        ops.push({ op: 'add', kind: 'preference', content: `They dislike ${clean(m[1]!)}.`, importance: 0.6, sensitive: false, explicit: false });
      }
      if ((m = /\b(?:my goal is to|i want to|i'?m trying to) ([^.,!?]+)/i.exec(line))) {
        ops.push({ op: 'add', kind: 'goal', content: `They want to ${clean(m[1]!)}.`, importance: 0.7, sensitive: false, explicit: false });
      }
      if ((m = /\bremember (?:that )?(.+)/i.exec(line)) || (m = /মনে রেখো(?: যে)?\s*(.+)/u.exec(line))) {
        const fact = clean(m[1]!).replace(/\bmy\b/gi, 'their').replace(/\bi am\b|\bi'm\b/gi, 'they are').replace(/\bi\b/gi, 'they');
        ops.push({ op: 'add', kind: 'fact', content: `They asked to remember: ${fact}.`, importance: 0.85, sensitive: /password|diagnos|salary|debt/i.test(fact), explicit: true });
      }
    }
  }
  const first = said[0] ?? '';
  const topic = tokenize(said.join(' ')).slice(0, 4).join(' ');
  return JSON.stringify({
    ops,
    summary: said.length ? `They talked about ${topic || 'everyday things'}. ${said.length > 1 ? `It started with: "${first.slice(0, 80)}".` : ''}`.trim() : '',
    title: topic ? topic.replace(/^./, (c) => c.toUpperCase()) : 'A short chat',
  });
}
