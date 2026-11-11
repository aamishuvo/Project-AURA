import type { Lang } from '../types';

/** Collision-resistant id that works in browsers, workers and Node. */
export function uid(prefix = ''): string {
  const c = (globalThis as any).crypto as Crypto | undefined;
  if (c?.randomUUID) return prefix + c.randomUUID().replace(/-/g, '').slice(0, 20);
  let s = '';
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(12);
    c.getRandomValues(bytes);
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
  } else {
    s = Math.random().toString(16).slice(2) + Date.now().toString(16);
  }
  return prefix + s.slice(0, 20);
}

const BENGALI = /[ঀ-৿]/;
const BENGALI_G = /[ঀ-৿]/g;
const LATIN_G = /[A-Za-z]/g;

export function hasBangla(text: string): boolean {
  return BENGALI.test(text);
}

/** Share of letters that are Bangla script, 0..1. */
export function banglaRatio(text: string): number {
  const b = text.match(BENGALI_G)?.length ?? 0;
  const l = text.match(LATIN_G)?.length ?? 0;
  return b + l === 0 ? 0 : b / (b + l);
}

/** Which voice should read this sentence. Any real Bangla content wins: a Bangla voice
 *  reads embedded English words the way a bilingual speaker would. */
export function speechLang(text: string): Lang {
  return banglaRatio(text) >= 0.2 ? 'bn' : 'en';
}

// Common romanised-Bangla function words; enough to spot "Banglish" typed or transcribed in Latin letters.
const BANGLISH_HINTS = new Set(
  (
    'ami tumi apni amar tomar apnar ki keno kothay kemon acho achen bhalo valo na nai hobe hoy hocche korbo korchi korcho ' +
    'kore korte chai jani jano bolo bolte bujhi bujhte ekta onek khub ektu ajke kalke ekhon tarpor kintu karon jodi tahole ' +
    'ache nei theke sathe jonno moto shob kichu keu amra tomra ora eta ota eita oita thik accha hae haan dhonnobad'
  ).split(' '),
);

/** True when Latin-script text is probably Bangla written in English letters. */
export function looksBanglish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0) return false;
  let hits = 0;
  for (const w of words) if (BANGLISH_HINTS.has(w)) hits++;
  return hits >= 2 && hits / words.length >= 0.25;
}

export type DetectedLanguage = 'en' | 'bn' | 'mixed';

export function detectLanguage(text: string): DetectedLanguage {
  const ratio = banglaRatio(text);
  if (ratio >= 0.85) return 'bn';
  if (ratio >= 0.15) return 'mixed';
  if (looksBanglish(text)) return 'mixed';
  return 'en';
}

const EN_STOP = new Set(
  (
    'a an the and or but if so of to in on at for from by with about as is are was were be been being am do does did ' +
    'have has had i you he she it we they me my your his her its our their this that these those there here what which who ' +
    'whom when where why how not no yes can could will would shall should may might must just very really also too than then ' +
    'them us him some any all each more most other such only own same into out up down over under again once s t d ll re ve m'
  ).split(' '),
);
const BN_STOP = new Set(
  (
    'আমি তুমি আপনি সে তারা আমরা আমার তোমার আপনার তার এই ওই সেই এটা ওটা কি কী কেন কোথায় কখন কেমন এবং আর ও কিন্তু বা যদি তবে ' +
    'তাই না নয় নেই হ্যাঁ হয় হয়ে হবে ছিল আছে করে করি করো করেন করতে থেকে জন্য সাথে মতো খুব একটু একটা অনেক কিছু সব'
  ).split(' '),
);

/** Lower-cased content words for lexical matching; works for English and Bangla. */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().normalize('NFC').match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (let w of raw) {
    if (EN_STOP.has(w) || BN_STOP.has(w)) continue;
    if (/^[a-z]+$/.test(w) && w.length > 4) w = stem(w);
    if (w.length > 1 || /\p{N}/u.test(w)) out.push(w);
  }
  return out;
}

/** Very light English stemming so "building / builds / built a robot" style variants mostly meet. */
function stem(w: string): string {
  let s = w;
  if (/(ches|shes|sses|xes|zes)$/.test(s)) s = s.slice(0, -2);
  else if (/[^siu]s$/.test(s)) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  if (/([b-df-hj-np-tv-z])\1$/.test(s) && !/(ll|ss)$/.test(s)) s = s.slice(0, -1); // runn → run
  return s;
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/** "3 days ago", "yesterday", "earlier today" — for prompts and the history panel. */
export function relativeTime(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 90) return 'moments ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 5) return h === 1 ? 'an hour ago' : `${h} hours ago`;
  const dNow = new Date(now);
  const dFrom = new Date(from);
  const dayDiff = Math.round(
    (Date.UTC(dNow.getFullYear(), dNow.getMonth(), dNow.getDate()) -
      Date.UTC(dFrom.getFullYear(), dFrom.getMonth(), dFrom.getDate())) /
      86400000,
  );
  if (dayDiff === 0) return 'earlier today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7) return `${dayDiff} days ago`;
  if (dayDiff < 14) return 'about a week ago';
  if (dayDiff < 60) return `${Math.round(dayDiff / 7)} weeks ago`;
  if (dayDiff < 365) return `${Math.round(dayDiff / 30)} months ago`;
  return 'over a year ago';
}
