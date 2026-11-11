import { MEMORY_KINDS, type MemoryItem, type MemoryKind, type Turn } from '../types';
import { extractJson } from '../llm/types';
import { clamp, jaccard, relativeTime, tokenize, uid } from '../util/text';

/**
 * Long-term memory management.
 *
 *   conversation ──► curator (LLM) ──► ops ──► validation + privacy filter ──► store
 *                                                   │
 *                          retrieval ◄──────────────┘  (budgeted, relevance-ranked)
 *
 * The curator proposes operations; this module decides what is actually stored.
 * Nothing the model returns is trusted: every op is validated, de-duplicated and
 * passed through the privacy rules below before it touches the store.
 */

// ───────────────────────────── retrieval ─────────────────────────────

const KIND_ORDER: Record<MemoryKind, number> = {
  identity: 0,
  relationship: 1,
  preference: 2,
  goal: 3,
  project: 4,
  event: 5,
  fact: 6,
  topic: 7,
  rapport: 8,
};

export interface SelectOptions {
  now: number;
  /** Rough character budget for the memory section of the prompt. */
  budgetChars?: number;
  maxItems?: number;
}

/**
 * Choose which memories go into the prompt for this turn.
 * Small memories are passed whole (the model is the best judge of relevance);
 * larger ones are ranked by lexical relevance, importance and recency.
 */
export function selectMemories(all: MemoryItem[], query: string, opts: SelectOptions): MemoryItem[] {
  const budget = opts.budgetChars ?? 3200;
  const maxItems = opts.maxItems ?? 48;
  const total = all.reduce((n, m) => n + m.content.length + 24, 0);
  let chosen: MemoryItem[];
  if (total <= budget && all.length <= maxItems) {
    chosen = [...all];
  } else {
    const q = tokenize(query);
    const docs = all.map((m) => tokenize(m.content));
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    const N = all.length;
    const avgLen = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, N);
    const rel = docs.map((d) => {
      if (q.length === 0 || d.length === 0) return 0;
      let s = 0;
      for (const term of new Set(q)) {
        const tf = d.filter((t) => t === term).length;
        if (!tf) continue;
        const idf = Math.log(1 + (N - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
        s += (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + 0.75 * (d.length / avgLen)));
      }
      return s;
    });
    const maxRel = Math.max(1e-6, ...rel);
    const scored = all.map((m, i) => {
      const ageDays = Math.max(0, (opts.now - (m.lastUsedAt ?? m.updatedAt)) / 86400000);
      const score =
        0.5 * (rel[i]! / maxRel) +
        0.3 * m.importance +
        0.1 * Math.exp(-ageDays / 90) +
        (m.pinned ? 1 : 0) +
        (m.kind === 'identity' ? 0.35 : 0);
      return { m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    chosen = [];
    let used = 0;
    for (const { m } of scored) {
      const cost = m.content.length + 24;
      if (chosen.length >= maxItems) break;
      if (used + cost > budget && chosen.length > 0) continue;
      chosen.push(m);
      used += cost;
    }
  }
  return chosen.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.importance - a.importance);
}

export function formatMemoriesForPrompt(memories: MemoryItem[], now: number): string {
  if (memories.length === 0) return 'Nothing yet. You are still getting to know them.';
  return memories
    .map((m) => {
      const dated = m.kind === 'project' || m.kind === 'goal' || m.kind === 'event';
      const when = dated ? `, noted ${relativeTime(m.updatedAt, now)}` : '';
      return `- ${m.content} (${m.kind}${when})`;
    })
    .join('\n');
}

// ───────────────────────────── curation ─────────────────────────────

export type MemoryOp =
  | { op: 'add'; kind: MemoryKind; content: string; importance: number; sensitive: boolean; explicit: boolean }
  | { op: 'update'; id: string; content: string; reason?: string; importance?: number }
  | { op: 'delete'; id: string; reason?: string };

export interface CurationResult {
  ops: MemoryOp[];
  summary: string;
  title: string;
}

export const CURATOR_MARKER = 'MEMORY_CURATOR_V1';

export interface CuratorPromptInput {
  companionName: string;
  existing: MemoryItem[];
  turns: Turn[];
  previousSummary: string;
  now: number;
  timeZone?: string;
  /** When false the curator only summarises; no memory operations are requested. */
  learn: boolean;
  allowSensitive: boolean;
}

export interface CuratorPrompt {
  system: string;
  user: string;
  /** Maps the short aliases used in the prompt (m1, m2 …) back to real ids. */
  aliases: Map<string, string>;
}

function formatDate(now: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone,
    }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

export function buildCuratorPrompt(input: CuratorPromptInput): CuratorPrompt {
  const name = input.companionName;
  const aliases = new Map<string, string>();
  const existing = input.existing
    .map((m, i) => {
      const alias = `m${i + 1}`;
      aliases.set(alias, m.id);
      return `[${alias}] (${m.kind}${m.pinned ? ', pinned' : ''}) ${m.content}`;
    })
    .join('\n');

  const sensitiveRule = input.allowSensitive
    ? 'Store a sensitive fact only when they stated it plainly about themselves, and mark it "sensitive": true.'
    : 'Do not store sensitive facts at all, unless they explicitly asked for it to be remembered ("remember that…"); then mark it "sensitive": true and "explicit": true.';

  const learnRules = input.learn
    ? `Remember only what will still matter in later conversations:
- who they are: name, work or studies, where they live, the people close to them
- stable preferences and dislikes
- ongoing projects, plans and goals, and how they are progressing
- important events, with dates when known
- recurring topics they care about
- how they like to be talked to, and running jokes between them and ${name} (kind "rapport")

Do not remember small talk, passing moods, one-off questions, anything ${name} said, guesses, or things said hypothetically or as a joke. When in doubt, leave it out. An empty "ops" list is the common, correct answer.

Privacy rules:
- Never infer sensitive attributes: health, mental health, sexuality, religion, politics, finances, legal trouble, immigration status.
- ${sensitiveRule}
- If they ask to forget something, or say not to remember something, delete every matching memory and store nothing about it.
- Never store passwords, card numbers, identity numbers or other credentials.

Contradictions and changes:
- If new information replaces something already remembered (they moved, changed jobs, changed their mind), UPDATE that memory by its id with the new truth. Never add a second, conflicting memory.
- If new information adds detail to an existing memory, UPDATE it into one fuller sentence.
- Do not add anything that is already remembered. Pinned memories may be deleted on request but are otherwise left alone.

Write each memory as one short, self-contained English sentence in the third person, beginning "They" or "Their" (for example "Their name is Shuvo." or "They are preparing a thesis defence in March 2027."). Keep names and Bangla words exactly as they said them. Turn relative dates into absolute ones using today's date.`
    : 'Memory learning is switched off. Return an empty "ops" list.';

  const system = `${CURATOR_MARKER}
You maintain the long-term memory of a voice companion called ${name}. You receive what is already remembered about one person and the newest part of a conversation with them. Decide what, if anything, should change.

${learnRules}

Also write:
- "summary": two to four factual sentences covering this whole conversation so far, in the third person, for ${name} to read before their next conversation.
- "title": three to six words naming the conversation.

Reply with only one JSON object and no other text:
{"ops":[{"op":"add","kind":"identity|preference|fact|project|goal|relationship|event|topic|rapport","content":"…","importance":0.7,"sensitive":false,"explicit":false},{"op":"update","id":"m3","content":"…","reason":"…"},{"op":"delete","id":"m5","reason":"…"}],"summary":"…","title":"…"}
"importance" runs from 0 to 1. "explicit" is true only when they directly asked for this to be remembered.`;

  const transcript = input.turns
    .map((t) => `${t.role === 'user' ? 'Them' : name}: ${t.text}${t.interrupted ? ' [cut off]' : ''}`)
    .join('\n');

  const user = `Today is ${formatDate(input.now, input.timeZone)}.

Already remembered:
${existing || 'Nothing yet.'}

Conversation summary so far: ${input.previousSummary || '(this is the start of the conversation)'}

Newest part of the conversation:
${transcript}`;

  return { system, user, aliases };
}

const KIND_SET = new Set<string>(MEMORY_KINDS);
const DEFAULT_IMPORTANCE: Record<MemoryKind, number> = {
  identity: 0.9,
  relationship: 0.7,
  preference: 0.6,
  goal: 0.75,
  project: 0.7,
  event: 0.5,
  fact: 0.5,
  topic: 0.4,
  rapport: 0.5,
};

const MAX_CONTENT = 260;
const MAX_OPS = 8;

const cleanContent = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT) : '';

/** Parse and validate curator output. Anything malformed is dropped, never repaired by guesswork. */
export function parseCuration(raw: string, aliases?: Map<string, string>): CurationResult {
  const data = extractJson<Record<string, unknown>>(raw);
  const result: CurationResult = { ops: [], summary: '', title: '' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result;
  if (typeof data.summary === 'string') result.summary = data.summary.replace(/\s+/g, ' ').trim().slice(0, 700);
  if (typeof data.title === 'string') result.title = data.title.replace(/\s+/g, ' ').trim().slice(0, 70);
  const ops = Array.isArray(data.ops) ? data.ops : [];
  const resolve = (id: unknown): string | null => {
    if (typeof id !== 'string') return null;
    const key = id.replace(/[\[\]\s]/g, '');
    return aliases ? (aliases.get(key) ?? null) : key || null;
  };
  for (const item of ops) {
    if (result.ops.length >= MAX_OPS) break;
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (o.op === 'add') {
      const content = cleanContent(o.content);
      if (content.length < 6) continue;
      const kind = (typeof o.kind === 'string' && KIND_SET.has(o.kind) ? o.kind : 'fact') as MemoryKind;
      const importance = typeof o.importance === 'number' && Number.isFinite(o.importance) ? clamp(o.importance, 0, 1) : DEFAULT_IMPORTANCE[kind];
      result.ops.push({ op: 'add', kind, content, importance, sensitive: o.sensitive === true, explicit: o.explicit === true });
    } else if (o.op === 'update') {
      const id = resolve(o.id);
      const content = cleanContent(o.content);
      if (!id || content.length < 6) continue;
      result.ops.push({
        op: 'update',
        id,
        content,
        reason: typeof o.reason === 'string' ? o.reason.slice(0, 120) : undefined,
        importance: typeof o.importance === 'number' && Number.isFinite(o.importance) ? clamp(o.importance, 0, 1) : undefined,
      });
    } else if (o.op === 'delete') {
      const id = resolve(o.id);
      if (!id) continue;
      result.ops.push({ op: 'delete', id, reason: typeof o.reason === 'string' ? o.reason.slice(0, 120) : undefined });
    }
  }
  return result;
}

// ───────────────────────────── privacy filter ─────────────────────────────

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(?:\d[ -]?){13,19}\b/, // payment card numbers
  /\b(password|passcode|passphrase|pin|otp|cvv|secret key|api key|private key|seed phrase)\b\s*(is|:|=)/i,
  /\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/, // API tokens
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN shape
  /\b(nid|passport|national id)\b.{0,24}\b[A-Z0-9]{8,}\b/i,
];

const SENSITIVE_HINTS =
  /\b(diagnos|depress|anxiety|bipolar|adhd|therapy|therapist|medication|antidepress|cancer|hiv|pregnan|miscarr|abortion|suicid|self[- ]harm|gay|lesbian|bisexual|transgender|queer|religio|muslim|hindu|christian|atheis|politic|votes? for|salary|debt|loan|bankrupt|arrest|convict|lawsuit|immigration|visa status|asylum)\w*/i;

export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => p.test(text));
}

export function looksSensitive(text: string): boolean {
  return SENSITIVE_HINTS.test(text);
}

// ───────────────────────────── applying ops ─────────────────────────────

export interface MemoryChange {
  type: 'added' | 'updated' | 'deleted' | 'skipped';
  memory?: MemoryItem;
  id?: string;
  reason?: string;
}

export interface ApplyContext {
  now: number;
  allowSensitive: boolean;
  conversationId?: string;
  /** Hard cap on stored memories; the least valuable are pruned beyond it. */
  maxMemories?: number;
}

export interface ApplyResult {
  upsert: MemoryItem[];
  remove: string[];
  changes: MemoryChange[];
}

const DUPLICATE_THRESHOLD = 0.72;

/**
 * How alike two memories are. Jaccard alone misses "the same fact with more detail",
 * so a sentence whose content words are (nearly) all contained in the other also counts.
 */
function similarity(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  if (small.size === 0) return 0;
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  const containment = small.size >= 3 ? (inter / small.size) * 0.9 : 0;
  return Math.max(jaccard(a, b), containment);
}

export function newMemory(
  input: { content: string; kind: MemoryKind; importance?: number; sensitive?: boolean; pinned?: boolean; origin?: 'conversation' | 'user'; confidence?: number; conversationId?: string },
  now: number,
): MemoryItem {
  return {
    id: uid('mem_'),
    kind: input.kind,
    content: cleanContent(input.content),
    importance: clamp(input.importance ?? DEFAULT_IMPORTANCE[input.kind], 0, 1),
    confidence: clamp(input.confidence ?? 0.75, 0, 1),
    sensitive: input.sensitive ?? false,
    pinned: input.pinned ?? false,
    origin: input.origin ?? 'conversation',
    createdAt: now,
    updatedAt: now,
    history: [],
    sourceConversationId: input.conversationId,
  };
}

function revise(m: MemoryItem, content: string, now: number, reason?: string): MemoryItem {
  if (m.content === content) return m;
  return {
    ...m,
    content,
    updatedAt: now,
    history: [...m.history, { content: m.content, at: m.updatedAt, reason }].slice(-5),
  };
}

/** Apply validated ops to the current memory set and return the resulting store changes. */
export function applyMemoryOps(current: MemoryItem[], ops: MemoryOp[], ctx: ApplyContext): ApplyResult {
  const byId = new Map(current.map((m) => [m.id, m] as const));
  const touched = new Map<string, MemoryItem>();
  const removed = new Set<string>();
  const changes: MemoryChange[] = [];
  const live = () => [...byId.values()].filter((m) => !removed.has(m.id));

  for (const op of ops) {
    if (op.op === 'delete') {
      const m = byId.get(op.id);
      if (!m || removed.has(op.id)) continue;
      removed.add(op.id);
      touched.delete(op.id);
      changes.push({ type: 'deleted', id: op.id, memory: m, reason: op.reason });
      continue;
    }

    if (looksLikeCredential(op.content)) {
      changes.push({ type: 'skipped', reason: 'looks like a credential' });
      continue;
    }

    if (op.op === 'update') {
      const m = byId.get(op.id);
      if (!m || removed.has(op.id)) continue;
      if (m.pinned) {
        changes.push({ type: 'skipped', id: m.id, reason: 'pinned memories are not edited automatically' });
        continue;
      }
      const sensitive = m.sensitive || looksSensitive(op.content);
      if (sensitive && !m.sensitive && !ctx.allowSensitive) {
        changes.push({ type: 'skipped', id: m.id, reason: 'sensitive detail not stored' });
        continue;
      }
      const next = { ...revise(m, op.content, ctx.now, op.reason), sensitive };
      if (op.importance !== undefined) next.importance = op.importance;
      byId.set(m.id, next);
      touched.set(m.id, next);
      changes.push({ type: 'updated', id: m.id, memory: next, reason: op.reason });
      continue;
    }

    // add
    const sensitive = op.sensitive || looksSensitive(op.content);
    if (sensitive && !ctx.allowSensitive && !op.explicit) {
      changes.push({ type: 'skipped', reason: 'sensitive detail not stored' });
      continue;
    }
    const tokens = tokenize(op.content);
    let duplicate: MemoryItem | undefined;
    let best = 0;
    for (const m of live()) {
      const sim = similarity(tokens, tokenize(m.content));
      if (sim > best) {
        best = sim;
        duplicate = m;
      }
    }
    if (duplicate && best >= DUPLICATE_THRESHOLD) {
      // Same fact again: keep the more detailed wording, never store twice.
      if (!duplicate.pinned && op.content.length > duplicate.content.length + 8) {
        const next = revise(duplicate, op.content, ctx.now, 'more detail');
        byId.set(next.id, next);
        touched.set(next.id, next);
        changes.push({ type: 'updated', id: next.id, memory: next, reason: 'more detail' });
      } else {
        changes.push({ type: 'skipped', id: duplicate.id, reason: 'already remembered' });
      }
      continue;
    }
    const created = newMemory(
      {
        content: op.content,
        kind: op.kind,
        importance: op.explicit ? Math.max(op.importance, 0.8) : op.importance,
        sensitive,
        confidence: op.explicit ? 0.95 : 0.75,
        conversationId: ctx.conversationId,
      },
      ctx.now,
    );
    byId.set(created.id, created);
    touched.set(created.id, created);
    changes.push({ type: 'added', id: created.id, memory: created });
  }

  // Keep the store bounded: prune the least valuable unpinned, learned memories.
  const cap = ctx.maxMemories ?? 400;
  const alive = live();
  if (alive.length > cap) {
    const prunable = alive
      .filter((m) => !m.pinned && m.origin === 'conversation')
      .map((m) => ({ m, value: m.importance + 0.3 * Math.exp(-(ctx.now - m.updatedAt) / (86400000 * 120)) }))
      .sort((a, b) => a.value - b.value);
    for (const { m } of prunable.slice(0, alive.length - cap)) {
      removed.add(m.id);
      touched.delete(m.id);
      changes.push({ type: 'deleted', id: m.id, memory: m, reason: 'pruned to stay within the memory limit' });
    }
  }

  return { upsert: [...touched.values()], remove: [...removed], changes };
}

// ───────────────────────────── scheduling heuristics ─────────────────────────────

const EXPLICIT_MEMORY_COMMAND =
  /\b(remember|don'?t forget|keep in mind|note that|forget (that|about|what|it|this|everything)|don'?t remember|stop remembering)\b|মনে রেখো|মনে রাখো|মনে রাখবে|মনে রাখুন|ভুলে যাও|ভুলে যান|মনে রেখ/i;

export function hasExplicitMemoryCommand(text: string): boolean {
  return EXPLICIT_MEMORY_COMMAND.test(text);
}

/** Is there anything in these turns worth a curator call? Keeps usage down on small talk. */
export function worthCurating(turns: Turn[]): boolean {
  const userTurns = turns.filter((t) => t.role === 'user');
  if (userTurns.length === 0) return false;
  if (userTurns.some((t) => hasExplicitMemoryCommand(t.text))) return true;
  const content = userTurns.reduce((n, t) => n + tokenize(t.text).length, 0);
  if (content >= 4) return true;
  // Short but personal ("My name is Shuvo") is exactly what memory is for.
  return content >= 2 && userTurns.some((t) => FIRST_PERSON.test(t.text));
}

const FIRST_PERSON = /\b(i|i'm|i am|my|mine|we|our)\b|আমি|আমার|আমরা|আমাদের/i;
