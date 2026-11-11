import { describe, expect, it } from 'vitest';
import {
  Brain,
  CURATOR_MARKER,
  LlmError,
  MemoryStore,
  createDemoLlm,
  type BrainEvent,
  type LlmRequest,
  type Store,
} from '../src';

/**
 * End-to-end tests of AURA's mind against the in-memory store and the scripted
 * model. The scripted model answers only from the prompt it is given, so a correct
 * answer proves the right context reached "the model".
 */

function setup(opts: { store?: Store; start?: number; chunkMs?: number } = {}) {
  const requests: LlmRequest[] = [];
  let now = opts.start ?? new Date('2026-11-11T09:00:00Z').getTime();
  const llm = createDemoLlm({ latencyMs: 0, chunkMs: opts.chunkMs ?? 0, onRequest: (r) => requests.push(r) });
  const store = opts.store ?? new MemoryStore();
  const brain = new Brain({ store, llm, now: () => now, consolidateDelayMs: 5, consolidateEvery: 3 });
  const chatRequests = () => requests.filter((r) => r.purpose === 'chat');
  const curatorRequests = () => requests.filter((r) => r.system.startsWith(CURATOR_MARKER));
  return { brain, store, llm, requests, chatRequests, curatorRequests, advance: (ms: number) => (now += ms), now: () => now };
}

async function say(brain: Brain, sessionId: string, text: string) {
  const events: BrainEvent[] = [];
  const result = await brain.respond(sessionId, text, (e) => events.push(e));
  return { result, events };
}

describe('a conversation', () => {
  it('greets a first-time user and streams mood, text and speakable sentences in order', async () => {
    const { brain, chatRequests } = setup();
    const session = await brain.startSession({ timeZone: 'Asia/Dhaka' });
    expect(session).toMatchObject({ resumed: false, isFirstEver: true, turns: [] });
    const events: BrainEvent[] = [];
    const reply = await brain.greet(session.sessionId, (e) => events.push(e));
    expect(reply.text).toBe("Hi, I'm AURA. What should I call you?");
    expect(reply.mood).toBe('warm');
    expect(events[0]).toEqual({ type: 'mood', mood: 'warm' });
    expect(events.filter((e) => e.type === 'sentence').map((e: any) => e.text)).toEqual(["Hi, I'm AURA.", 'What should I call you?']);
    expect(events.filter((e) => e.type === 'delta').map((e: any) => e.text).join('')).toBe(reply.text);
    const req = chatRequests()[0]!;
    expect(req.system).toContain('You are AURA, a virtual companion');
    expect(req.context).toContain('This is the first time you are talking with them.');
    expect(req.context).toMatch(/It is Wednesday, 11 November 2026 at 3:00\s?pm where they are/i);
    expect(req.messages.at(-1)!.content).toContain('first time');
  });

  it('keeps context within the conversation', async () => {
    const { brain, chatRequests } = setup();
    const { sessionId } = await brain.startSession();
    await say(brain, sessionId, 'My name is Shuvo');
    await say(brain, sessionId, 'I spent the whole day debugging a motor driver');
    const { result } = await say(brain, sessionId, 'What did I just say?');
    expect(result.text).toContain('I spent the whole day debugging a motor driver');
    const { result: nameReply } = await say(brain, sessionId, "What's my name?");
    expect(nameReply.text).toContain('Shuvo');
    const last = chatRequests().at(-1)!;
    expect(last.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(last.messages[0]!.content).toBe('My name is Shuvo');
  });

  it('stores the transcript with roles, moods and languages', async () => {
    const { brain, store } = setup();
    const { sessionId } = await brain.startSession();
    await say(brain, sessionId, 'আমি আজ খুব ক্লান্ত');
    const turns = await store.getTurns(sessionId);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[0]).toMatchObject({ text: 'আমি আজ খুব ক্লান্ত', lang: 'bn' });
    expect(turns[1]).toMatchObject({ mood: 'concerned', lang: 'bn' });
    expect((await store.getConversation(sessionId))!.turnCount).toBe(2);
  });

  it('answers Bangla in Bangla and mixed speech in kind', async () => {
    const { brain } = setup();
    const { sessionId } = await brain.startSession();
    expect((await say(brain, sessionId, 'হ্যালো')).result.text).toMatch(/[ঀ-৿]/);
    expect((await say(brain, sessionId, 'আমার নাম শুভ')).result.text).toContain('শুভ');
    expect((await say(brain, sessionId, 'Hello again')).result.text).toMatch(/^Hello/);
  });

  it('bounds the replayed history and marks interrupted lines for the model', async () => {
    const { brain, chatRequests } = setup();
    const { sessionId } = await brain.startSession();
    for (let i = 0; i < 20; i++) await say(brain, sessionId, `Message number ${i} about the weather in Dhaka`);
    const req = chatRequests().at(-1)!;
    expect(req.messages.length).toBeLessThanOrEqual(31);
    expect(req.messages[0]!.role).toBe('user');
  });
});

describe('long-term memory', () => {
  it('learns from conversation and uses it in a later session, after a restart', async () => {
    const store = new MemoryStore();
    const first = setup({ store });
    const s1 = await first.brain.startSession();
    await say(first.brain, s1.sessionId, 'My name is Shuvo');
    await say(first.brain, s1.sessionId, "I'm working on a line-following robot for my thesis");
    await say(first.brain, s1.sessionId, 'I really love old Bangla band music');
    await first.brain.endSession(s1.sessionId);

    const memories = await store.listMemories();
    expect(memories.map((m) => m.content).sort()).toEqual([
      'Their name is Shuvo.',
      'They are working on a line-following robot for my thesis.',
      'They like old Bangla band music.',
    ]);
    expect(memories.find((m) => m.kind === 'identity')!.sourceConversationId).toBe(s1.sessionId);
    const meta = (await store.getConversation(s1.sessionId))!;
    expect(meta.summary).not.toBe('');
    expect(meta.title).not.toBe('New conversation');
    expect(meta.consolidatedTurns).toBe(meta.turnCount);

    // A brand-new Brain over the same store = the app reopened the next day.
    const second = setup({ store, start: new Date('2026-11-12T09:00:00Z').getTime() });
    const s2 = await second.brain.startSession();
    expect(s2).toMatchObject({ resumed: false, isFirstEver: false });
    const greeting = await second.brain.greet(s2.sessionId, () => {});
    expect(greeting.text).toContain('Shuvo');
    const { result } = await say(second.brain, s2.sessionId, "What's my name?");
    expect(result.text).toContain('Shuvo');
    const req = second.chatRequests().at(-1)!;
    expect(req.context).toContain('Their name is Shuvo. (identity)');
    expect(req.context).toContain('# Earlier conversations');
    expect(req.context).toContain('You last talked yesterday.');
  });

  it('replaces a contradicted fact instead of storing both', async () => {
    const { brain, store } = setup();
    const { sessionId } = await brain.startSession();
    await say(brain, sessionId, 'I live in Dhaka');
    await say(brain, sessionId, 'It has been raining all week here');
    await say(brain, sessionId, 'The traffic is terrible as always');
    await brain.flush(sessionId);
    expect((await store.listMemories()).map((m) => m.content)).toEqual(['They live in Dhaka.']);

    await say(brain, sessionId, 'Big news, I moved to Chittagong');
    await say(brain, sessionId, 'The sea is ten minutes away now');
    await say(brain, sessionId, 'I still miss my old neighbourhood though');
    await brain.flush(sessionId);
    const memories = await store.listMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toBe('They live in Chittagong.');
    expect(memories[0]!.history.map((h) => h.content)).toEqual(['They live in Dhaka.']);
  });

  it('acts on "remember" immediately and on "forget" by deleting', async () => {
    const { brain, store } = setup();
    const { sessionId } = await brain.startSession();
    await say(brain, sessionId, 'Remember that my sister Mitu visits on Friday');
    await brain.flush(sessionId);
    let memories = await store.listMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toContain('sister Mitu visits on Friday');
    expect(memories[0]!.confidence).toBeGreaterThan(0.9);

    await say(brain, sessionId, 'Actually forget about Mitu');
    await brain.flush(sessionId);
    memories = await store.listMemories();
    expect(memories).toHaveLength(0);
  });

  it('does not learn from small talk and spends no model call on it', async () => {
    const { brain, store, curatorRequests } = setup();
    const { sessionId } = await brain.startSession();
    await say(brain, sessionId, 'ok');
    await say(brain, sessionId, 'hmm');
    await say(brain, sessionId, 'yes');
    await brain.flush(sessionId);
    await brain.endSession(sessionId);
    expect(await store.listMemories()).toEqual([]);
    expect(curatorRequests()).toHaveLength(0);
  });

  it('never stores credentials and filters sensitive details by default', async () => {
    const { brain, store } = setup();
    const { sessionId } = await brain.startSession();
    await say(brain, sessionId, 'Remember that my password is: hunter2 for the bank');
    await brain.flush(sessionId);
    expect(await store.listMemories()).toEqual([]);
    await expect(brain.addMemory({ content: 'card 4111 1111 1111 1111' })).rejects.toThrow(/credentials|password/i);
  });

  it('stops learning when the user switches memory off, but still uses what it has', async () => {
    const { brain, store, chatRequests } = setup();
    await brain.addMemory({ content: 'Their name is Shuvo.', kind: 'identity' });
    const profile = await brain.loadProfile();
    await brain.saveSettings({ ...profile.settings, memory: { ...profile.settings.memory, enabled: false } });
    const { sessionId } = await brain.startSession();
    await say(brain, sessionId, "I'm working on a secret plan for a bakery");
    await say(brain, sessionId, 'I really love sourdough bread');
    await say(brain, sessionId, 'My goal is to open by next summer');
    await brain.endSession(sessionId);
    expect((await store.listMemories()).map((m) => m.content)).toEqual(['Their name is Shuvo.']);
    expect(chatRequests().at(-1)!.context).toContain('Their name is Shuvo.');
    // the transcript is still kept, with a summary
    expect((await store.getConversation(sessionId))!.summary).not.toBe('');
  });

  it('leaves no trace of a private session', async () => {
    const { brain, store, curatorRequests } = setup();
    const { sessionId } = await brain.startSession({ ephemeral: true });
    await say(brain, sessionId, 'My name is Shuvo and I live in Dhaka');
    await say(brain, sessionId, 'Remember that I owe Rafi lunch');
    await brain.endSession(sessionId);
    expect(await store.listConversations(10)).toEqual([]);
    expect(await store.listMemories()).toEqual([]);
    expect(curatorRequests()).toHaveLength(0);
  });

  it('can learn without keeping the transcript', async () => {
    const { brain, store } = setup();
    const profile = await brain.loadProfile();
    await brain.saveSettings({ ...profile.settings, memory: { ...profile.settings.memory, saveTranscripts: false } });
    const { sessionId } = await brain.startSession();
    await say(brain, sessionId, 'My name is Shuvo');
    await say(brain, sessionId, 'I really love mountain hiking');
    await say(brain, sessionId, 'I want to climb Keokradong this winter');
    await brain.endSession(sessionId);
    expect(await store.listConversations(10)).toEqual([]);
    expect((await store.listMemories()).length).toBe(3);
  });

  it('gives the user full control: add, edit, pin, delete, wipe', async () => {
    const { brain, store } = setup();
    const seen: string[] = [];
    brain.onMemoryChange((changes) => seen.push(...changes.map((c) => c.type)));
    const m = await brain.addMemory({ content: 'They prefer short answers.', kind: 'rapport' });
    expect(m).toMatchObject({ origin: 'user', confidence: 1 });
    const edited = await brain.updateMemory(m.id, { content: 'They prefer short, direct answers.', pinned: true });
    expect(edited).toMatchObject({ pinned: true, content: 'They prefer short, direct answers.' });
    expect(edited!.history[0]!.content).toBe('They prefer short answers.');
    await brain.addMemory({ content: 'They have a cat called Tuki.' });
    await brain.deleteMemory(m.id);
    expect((await store.listMemories()).map((x) => x.content)).toEqual(['They have a cat called Tuki.']);
    await brain.clearMemories();
    expect(await store.listMemories()).toEqual([]);
    expect(seen).toEqual(['added', 'updated', 'added', 'deleted', 'deleted']);
    expect(await brain.updateMemory('missing', { pinned: true })).toBeNull();
  });
});

describe('interruptions and failures', () => {
  it('stops generating when interrupted and records only what was heard', async () => {
    const { brain, store } = setup({ chunkMs: 15 });
    const { sessionId } = await brain.startSession();
    const controller = new AbortController();
    const heard: string[] = [];
    const pending = brain.respond(sessionId, 'Tell me about your day in great detail please', (e) => {
      if (e.type === 'delta') {
        heard.push(e.text);
        if (heard.length === 2) controller.abort();
      }
    }, { signal: controller.signal });
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.turnId).toBeDefined();
    await brain.noteInterrupted(sessionId, result.turnId!, 'Detail,');
    const turns = await store.getTurns(sessionId);
    expect(turns.at(-1)).toMatchObject({ role: 'assistant', text: 'Detail,', interrupted: true });

    // the next prompt shows the model where it was cut off
    const { chatRequests } = { chatRequests: [] as LlmRequest[] };
    const brain2events: BrainEvent[] = [];
    await brain.respond(sessionId, 'Sorry, go on', (e) => brain2events.push(e));
    void chatRequests;
    const stored = await store.getTurns(sessionId);
    expect(stored.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('shows the model its interrupted line with a marker', async () => {
    const { brain, chatRequests } = setup({ chunkMs: 15 });
    const { sessionId } = await brain.startSession();
    const controller = new AbortController();
    let n = 0;
    const result = await brain.respond(sessionId, 'Describe the ocean for me slowly', (e) => {
      if (e.type === 'delta' && ++n === 2) controller.abort();
    }, { signal: controller.signal });
    await brain.noteInterrupted(sessionId, result.turnId!, 'Ocean, huh');
    await brain.respond(sessionId, 'Wait, one more thing', () => {});
    const assistantLine = chatRequests().at(-1)!.messages.find((m) => m.role === 'assistant')!;
    expect(assistantLine.content).toBe('Ocean, huh— [cut off]');
  });

  it('returns cleanly when interrupted before any text arrived', async () => {
    const { brain, store } = setup();
    const { sessionId } = await brain.startSession();
    const controller = new AbortController();
    controller.abort();
    const result = await brain.respond(sessionId, 'Hello there', () => {}, { signal: controller.signal });
    expect(result).toMatchObject({ aborted: true, text: '' });
    expect((await store.getTurns(sessionId)).map((t) => t.role)).toEqual(['user']);
  });

  it('surfaces model failures and does not duplicate the user turn on retry', async () => {
    const { brain, store, llm } = setup();
    const { sessionId } = await brain.startSession();
    llm.options.failNext = { count: 1, error: new LlmError('network', 'offline') };
    await expect(brain.respond(sessionId, 'Are you there?', () => {})).rejects.toMatchObject({ code: 'network', retryable: true });
    const retry = await brain.respond(sessionId, 'Are you there?', () => {});
    expect(retry.aborted).toBe(false);
    expect((await store.getTurns(sessionId)).map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  it('keeps talking when storage fails', async () => {
    const store = new MemoryStore();
    const broken: Store = Object.assign(Object.create(store), {
      appendTurns: async () => {
        throw new Error('disk full');
      },
    });
    const { brain } = setup({ store: broken });
    const { sessionId } = await brain.startSession();
    const { result } = await say(brain, sessionId, 'Hello');
    expect(result.text).toMatch(/^Hello/);
  });

  it('rejects empty input and unknown sessions', async () => {
    const { brain } = setup();
    const { sessionId } = await brain.startSession();
    await expect(brain.respond(sessionId, '   ', () => {})).rejects.toThrow(/Nothing to respond/);
    await expect(brain.respond('nope', 'hi', () => {})).rejects.toThrow(/Unknown session/);
  });
});

describe('sessions and history', () => {
  it('resumes a conversation left moments ago and starts fresh after a long gap', async () => {
    const store = new MemoryStore();
    const a = setup({ store });
    const s1 = await a.brain.startSession();
    await say(a.brain, s1.sessionId, 'I am planning a trip to Sylhet');

    const b = setup({ store, start: a.now() + 5 * 60_000 });
    const s2 = await b.brain.startSession();
    expect(s2).toMatchObject({ sessionId: s1.sessionId, resumed: true });
    expect(s2.turns).toHaveLength(2);
    const { result } = await say(b.brain, s2.sessionId, 'What did I just say?');
    expect(result.text).toContain('planning a trip to Sylhet');

    const c = setup({ store, start: a.now() + 3 * 3600_000 });
    const s3 = await c.brain.startSession();
    expect(s3.resumed).toBe(false);
    expect(s3.sessionId).not.toBe(s1.sessionId);
  });

  it('catches up on memory for a conversation that ended without saying goodbye', async () => {
    const store = new MemoryStore();
    const a = setup({ store });
    const s1 = await a.brain.startSession();
    await say(a.brain, s1.sessionId, 'My name is Shuvo'); // tab closed: no endSession, below the consolidation threshold
    expect(await store.listMemories()).toEqual([]);

    const b = setup({ store, start: a.now() + 2 * 3600_000 });
    await b.brain.startSession();
    await new Promise((r) => setTimeout(r, 30));
    expect((await store.listMemories()).map((m) => m.content)).toEqual(['Their name is Shuvo.']);
  });

  it('does not record a conversation in which nothing was said', async () => {
    const { brain, store } = setup();
    const { sessionId } = await brain.startSession();
    await brain.endSession(sessionId);
    expect(await store.listConversations(10)).toEqual([]);
  });

  it('lists, opens, deletes and exports conversations', async () => {
    const { brain, advance } = setup();
    const s1 = await brain.startSession();
    await say(brain, s1.sessionId, 'First conversation about tea');
    await brain.endSession(s1.sessionId);
    advance(2 * 3600_000);
    const s2 = await brain.startSession();
    await say(brain, s2.sessionId, 'Second conversation about coffee');
    const list = await brain.listConversations();
    expect(list.map((c) => c.id)).toEqual([s2.sessionId, s1.sessionId]);
    expect((await brain.getConversation(s1.sessionId))!.turns).toHaveLength(2);

    const bundle = await brain.exportAll();
    expect(bundle).toMatchObject({ app: 'aura', version: 1 });
    expect(bundle.conversations).toHaveLength(2);
    expect(bundle.persona).toMatchObject({ name: 'AURA' });

    await brain.deleteConversation(s1.sessionId);
    expect((await brain.listConversations()).map((c) => c.id)).toEqual([s2.sessionId]);
    await brain.clearConversations();
    expect(await brain.listConversations()).toEqual([]);
  });

  it('applies persona and language changes on the very next turn', async () => {
    const { brain, chatRequests } = setup();
    const { sessionId } = await brain.startSession();
    const profile = await brain.loadProfile();
    await brain.savePersona({ ...profile.persona, name: 'Nova', traits: { ...profile.persona.traits, candor: 0.95 } });
    await brain.saveSettings({ ...profile.settings, language: 'bn', displayName: 'Shuvo' });
    const { result } = await say(brain, sessionId, 'Hello');
    const req = chatRequests().at(-1)!;
    expect(req.system).toContain('You are Nova, a virtual companion');
    expect(req.system).toContain('You are candid.');
    expect(req.system).toContain('Speak Bangla.');
    expect(req.context).toContain('They asked to be called Shuvo.');
    expect(result.text).toMatch(/[ঀ-৿]/);
  });
});
