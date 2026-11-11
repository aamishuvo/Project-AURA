import { describe, expect, it } from 'vitest';
import {
  applyMemoryOps,
  buildCuratorPrompt,
  formatMemoriesForPrompt,
  hasExplicitMemoryCommand,
  looksLikeCredential,
  looksSensitive,
  newMemory,
  parseCuration,
  selectMemories,
  worthCurating,
  type MemoryItem,
  type MemoryOp,
  type Turn,
} from '../src';

const NOW = new Date('2026-11-11T10:00:00Z').getTime();
const mem = (content: string, over: Partial<MemoryItem> = {}): MemoryItem => ({ ...newMemory({ content, kind: over.kind ?? 'fact' }, NOW), ...over });
const turn = (role: 'user' | 'assistant', text: string): Turn => ({ id: `t${Math.random()}`, conversationId: 'c', role, text, createdAt: NOW });
const ctx = { now: NOW, allowSensitive: false };

describe('curator output validation', () => {
  it('accepts well-formed ops and resolves prompt aliases to real ids', () => {
    const aliases = new Map([['m1', 'mem_real']]);
    const r = parseCuration(
      '```json\n{"ops":[{"op":"add","kind":"project","content":"They are writing a novel.","importance":0.7,"sensitive":false,"explicit":false},{"op":"update","id":"[m1]","content":"They live in Chittagong.","reason":"moved"},{"op":"delete","id":"m1"}],"summary":"They talked about writing.","title":"The novel"}\n```',
      aliases,
    );
    expect(r.ops).toHaveLength(3);
    expect(r.ops[1]).toMatchObject({ op: 'update', id: 'mem_real' });
    expect(r.summary).toBe('They talked about writing.');
    expect(r.title).toBe('The novel');
  });

  it('drops malformed, unknown and oversized ops instead of guessing', () => {
    const r = parseCuration(
      JSON.stringify({
        ops: [
          { op: 'add', kind: 'nonsense', content: 'They like tea.' }, // unknown kind falls back to fact
          { op: 'add', content: 'x' }, // too short
          { op: 'update', id: 'm404', content: 'They moved.' }, // unknown alias
          { op: 'explode' },
          null,
          'string',
          { op: 'add', kind: 'fact', content: 'y'.repeat(900), importance: 55 },
        ],
      }),
      new Map(),
    );
    expect(r.ops).toHaveLength(2);
    expect(r.ops[0]).toMatchObject({ op: 'add', kind: 'fact', content: 'They like tea.' });
    const big = r.ops[1] as Extract<MemoryOp, { op: 'add' }>;
    expect(big.content.length).toBe(260);
    expect(big.importance).toBe(1);
  });

  it('returns nothing for non-JSON output and caps the number of ops', () => {
    expect(parseCuration('I could not decide.').ops).toEqual([]);
    const many = { ops: Array.from({ length: 30 }, (_, i) => ({ op: 'add', kind: 'fact', content: `They own item number ${i}.` })) };
    expect(parseCuration(JSON.stringify(many)).ops).toHaveLength(8);
  });
});

describe('applying memory operations', () => {
  it('adds new memories with provenance', () => {
    const r = applyMemoryOps([], [{ op: 'add', kind: 'identity', content: 'Their name is Shuvo.', importance: 0.9, sensitive: false, explicit: false }], { ...ctx, conversationId: 'conv_1' });
    expect(r.upsert).toHaveLength(1);
    expect(r.upsert[0]).toMatchObject({ kind: 'identity', origin: 'conversation', sourceConversationId: 'conv_1', pinned: false });
    expect(r.changes[0]!.type).toBe('added');
  });

  it('resolves contradictions by revising the memory and keeping its history', () => {
    const home = mem('They live in Dhaka.', { kind: 'identity' });
    const r = applyMemoryOps([home], [{ op: 'update', id: home.id, content: 'They live in Chittagong.', reason: 'they moved' }], { ...ctx, now: NOW + 1000 });
    expect(r.upsert).toHaveLength(1);
    expect(r.upsert[0]!.content).toBe('They live in Chittagong.');
    expect(r.upsert[0]!.history).toEqual([{ content: 'They live in Dhaka.', at: NOW, reason: 'they moved' }]);
    expect(r.upsert[0]!.updatedAt).toBe(NOW + 1000);
  });

  it('never stores the same fact twice', () => {
    const tea = mem('They like green tea in the morning.', { kind: 'preference' });
    const r = applyMemoryOps([tea], [{ op: 'add', kind: 'preference', content: 'They like green tea in the morning', importance: 0.5, sensitive: false, explicit: false }], ctx);
    expect(r.upsert).toHaveLength(0);
    expect(r.changes[0]).toMatchObject({ type: 'skipped', reason: 'already remembered' });
  });

  it('upgrades a memory when the same fact arrives with more detail', () => {
    const tea = mem('They like green tea.', { kind: 'preference' });
    const r = applyMemoryOps([tea], [{ op: 'add', kind: 'preference', content: 'They like green tea, especially Japanese sencha.', importance: 0.5, sensitive: false, explicit: false }], ctx);
    expect(r.upsert).toHaveLength(1);
    expect(r.upsert[0]!.id).toBe(tea.id);
    expect(r.upsert[0]!.history).toHaveLength(1);
  });

  it('deletes on request, including pinned memories', () => {
    const pinned = mem('They are allergic to peanuts.', { pinned: true });
    const r = applyMemoryOps([pinned], [{ op: 'delete', id: pinned.id, reason: 'asked to forget' }], ctx);
    expect(r.remove).toEqual([pinned.id]);
  });

  it('does not let the model rewrite a pinned memory', () => {
    const pinned = mem('Their birthday is 4 March.', { pinned: true });
    const r = applyMemoryOps([pinned], [{ op: 'update', id: pinned.id, content: 'Their birthday is 5 March.' }], ctx);
    expect(r.upsert).toHaveLength(0);
    expect(r.changes[0]!.type).toBe('skipped');
  });

  it('refuses sensitive details unless the user allowed them or asked explicitly', () => {
    const op = (explicit: boolean): MemoryOp => ({ op: 'add', kind: 'fact', content: 'They were diagnosed with anxiety last year.', importance: 0.6, sensitive: true, explicit });
    expect(applyMemoryOps([], [op(false)], ctx).upsert).toHaveLength(0);
    const explicit = applyMemoryOps([], [op(true)], ctx);
    expect(explicit.upsert).toHaveLength(1);
    expect(explicit.upsert[0]!.sensitive).toBe(true);
    expect(applyMemoryOps([], [op(false)], { ...ctx, allowSensitive: true }).upsert[0]!.sensitive).toBe(true);
  });

  it('catches sensitive content even when the model does not flag it', () => {
    const r = applyMemoryOps([], [{ op: 'add', kind: 'fact', content: 'They have 20 lakh taka of debt.', importance: 0.5, sensitive: false, explicit: false }], ctx);
    expect(r.upsert).toHaveLength(0);
    expect(looksSensitive('They are seeing a therapist.')).toBe(true);
    expect(looksSensitive('They like hiking.')).toBe(false);
  });

  it('never stores credentials, even when asked', () => {
    const ops: MemoryOp[] = [
      { op: 'add', kind: 'fact', content: 'Their password is: hunter2', importance: 0.9, sensitive: false, explicit: true },
      { op: 'add', kind: 'fact', content: 'Their card number is 4111 1111 1111 1111.', importance: 0.9, sensitive: false, explicit: true },
    ];
    const r = applyMemoryOps([], ops, { ...ctx, allowSensitive: true });
    expect(r.upsert).toHaveLength(0);
    expect(looksLikeCredential('my api key is sk-abcdefghijklmnopqrstuvwx')).toBe(true);
    expect(looksLikeCredential('They were born in 1994.')).toBe(false);
  });

  it('ignores ops that reference memories that do not exist', () => {
    const r = applyMemoryOps([], [{ op: 'update', id: 'ghost', content: 'They moved again.' }, { op: 'delete', id: 'ghost' }], ctx);
    expect(r.upsert).toEqual([]);
    expect(r.remove).toEqual([]);
  });

  it('prunes the least valuable learned memories beyond the cap, never pinned or user-written ones', () => {
    const current = [
      mem('They once mentioned a blue bicycle.', { importance: 0.1, updatedAt: NOW - 400 * 86400000 }),
      mem('Their name is Shuvo.', { kind: 'identity', importance: 0.95 }),
      mem('They are allergic to peanuts.', { importance: 0.1, pinned: true }),
      mem('They wrote this note themselves.', { importance: 0.1, origin: 'user' }),
    ];
    const r = applyMemoryOps(current, [{ op: 'add', kind: 'goal', content: 'They want to run a marathon in 2027.', importance: 0.8, sensitive: false, explicit: false }], { ...ctx, maxMemories: 4 });
    expect(r.remove).toEqual([current[0]!.id]);
    expect(r.upsert).toHaveLength(1);
  });
});

describe('memory retrieval', () => {
  it('passes a small memory whole, ordered with identity first', () => {
    const all = [mem('They enjoy cricket.', { kind: 'topic' }), mem('Their name is Shuvo.', { kind: 'identity' })];
    const picked = selectMemories(all, 'anything', { now: NOW });
    expect(picked.map((m) => m.kind)).toEqual(['identity', 'topic']);
  });

  it('ranks by relevance once memory outgrows the budget, always keeping identity and pinned items', () => {
    const filler = Array.from({ length: 80 }, (_, i) => mem(`They mentioned unrelated detail number ${i} about gardening tools and sheds.`, { importance: 0.3 }));
    const target = mem('They are building a line-following robot for their thesis.', { kind: 'project', importance: 0.7 });
    const name = mem('Their name is Shuvo.', { kind: 'identity', importance: 0.9 });
    const pin = mem('They are allergic to peanuts.', { pinned: true, importance: 0.2 });
    const picked = selectMemories([...filler, target, name, pin], 'how is the robot thesis going', { now: NOW, budgetChars: 900, maxItems: 10 });
    const ids = picked.map((m) => m.id);
    expect(ids).toContain(target.id);
    expect(ids).toContain(name.id);
    expect(ids).toContain(pin.id);
    expect(picked.length).toBeLessThanOrEqual(10);
    expect(picked.reduce((n, m) => n + m.content.length + 24, 0)).toBeLessThanOrEqual(900 + 100);
  });

  it('retrieves Bangla memories for Bangla queries', () => {
    const filler = Array.from({ length: 70 }, (_, i) => mem(`They mentioned unrelated detail number ${i} about office furniture.`, { importance: 0.3 }));
    const target = mem('তারা রবীন্দ্রসংগীত শুনতে ভালোবাসে।', { kind: 'preference', importance: 0.5 });
    const picked = selectMemories([...filler, target], 'আজ রবীন্দ্রসংগীত শুনব', { now: NOW, budgetChars: 600, maxItems: 6 });
    expect(picked.map((m) => m.id)).toContain(target.id);
  });

  it('formats memories for the prompt and says so honestly when there are none', () => {
    expect(formatMemoriesForPrompt([], NOW)).toMatch(/Nothing yet/);
    const text = formatMemoriesForPrompt([mem('They are writing a novel.', { kind: 'project', updatedAt: NOW - 3 * 86400000 })], NOW);
    expect(text).toBe('- They are writing a novel. (project, noted 3 days ago)');
  });
});

describe('curator prompt', () => {
  const base = { companionName: 'AURA', previousSummary: '', now: NOW, learn: true, allowSensitive: false };

  it('lists existing memories under short aliases and the new turns', () => {
    const existing = [mem('Their name is Shuvo.', { kind: 'identity' }), mem('They live in Dhaka.', { kind: 'identity', pinned: true })];
    const p = buildCuratorPrompt({ ...base, existing, turns: [turn('user', 'I moved to Chittagong last week.'), turn('assistant', 'Big change!')] });
    expect(p.user).toContain('[m1] (identity) Their name is Shuvo.');
    expect(p.user).toContain('[m2] (identity, pinned) They live in Dhaka.');
    expect(p.user).toContain('Them: I moved to Chittagong last week.');
    expect(p.user).toContain('AURA: Big change!');
    expect(p.user).toContain('Today is Wednesday, 11 November 2026');
    expect(p.aliases.get('m2')).toBe(existing[1]!.id);
  });

  it('states the privacy rules, and tightens them when sensitive storage is off', () => {
    const strict = buildCuratorPrompt({ ...base, existing: [], turns: [turn('user', 'hello there friend')] });
    expect(strict.system).toContain('Never infer sensitive attributes');
    expect(strict.system).toContain('Do not store sensitive facts at all, unless they explicitly asked');
    expect(strict.system).toContain('Never store passwords');
    const loose = buildCuratorPrompt({ ...base, allowSensitive: true, existing: [], turns: [turn('user', 'hello there friend')] });
    expect(loose.system).toContain('only when they stated it plainly about themselves');
  });

  it('asks only for a summary when learning is off', () => {
    const p = buildCuratorPrompt({ ...base, learn: false, existing: [], turns: [turn('user', 'hello there friend')] });
    expect(p.system).toContain('Memory learning is switched off');
    expect(p.system).not.toContain('Remember only what will still matter');
  });
});

describe('deciding when curation is worth a model call', () => {
  it('skips small talk and backchannels', () => {
    expect(worthCurating([turn('user', 'ok'), turn('assistant', 'Sure.'), turn('user', 'hmm yes')])).toBe(false);
    expect(worthCurating([turn('assistant', 'Hello!')])).toBe(false);
  });

  it('runs for substantive turns and explicit commands in either language', () => {
    expect(worthCurating([turn('user', 'I started a new job at a robotics startup in Dhaka')])).toBe(true);
    expect(worthCurating([turn('user', 'forget that')])).toBe(true);
    expect(hasExplicitMemoryCommand('Please remember that I am vegetarian')).toBe(true);
    expect(hasExplicitMemoryCommand('মনে রেখো আমি নিরামিষ খাই')).toBe(true);
    expect(hasExplicitMemoryCommand('ওটা ভুলে যাও')).toBe(true);
    expect(hasExplicitMemoryCommand('What is the weather like')).toBe(false);
  });
});
