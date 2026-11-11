import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  silentLogger,
  type ConversationMeta,
  type ExportBundle,
  type Logger,
  type MemoryItem,
  type MemoryKind,
  type Mood,
  type Turn,
  type UserSettings,
} from './types';
import { DEFAULT_PERSONA, normalizePersona, type PersonaConfig } from './persona/persona';
import { compilePersona } from './persona/compile';
import { buildContext, buildMessages, greetingCue } from './conversation/context';
import { ReplyStreamParser, guessMood } from './conversation/replyStream';
import { SentenceChunker } from './conversation/sentences';
import {
  applyMemoryOps,
  buildCuratorPrompt,
  hasExplicitMemoryCommand,
  looksLikeCredential,
  newMemory,
  parseCuration,
  selectMemories,
  worthCurating,
  type MemoryChange,
} from './memory/memory';
import { LlmError, isAbort, type LlmClient, type LlmTier } from './llm/types';
import type { Store } from './store/types';
import { detectLanguage, uid } from './util/text';

// ───────────────────────────── public API ─────────────────────────────

export type BrainEvent =
  /** Facial expression for what follows. */
  | { type: 'mood'; mood: Mood }
  /** Clean text as it is written (for captions). */
  | { type: 'delta'; text: string }
  /** A complete speakable chunk, in order. */
  | { type: 'sentence'; text: string; index: number };

export interface ReplyResult {
  text: string;
  mood: Mood;
  /** Id of AURA's stored turn; absent when nothing was produced. */
  turnId?: string;
  userTurnId?: string;
  aborted: boolean;
}

export interface SessionInfo {
  sessionId: string;
  /** True when an earlier conversation from the last half hour was continued. */
  resumed: boolean;
  isFirstEver: boolean;
  turns: Turn[];
}

export interface SessionOptions {
  /** Private session: nothing is stored and nothing is learned. */
  ephemeral?: boolean;
  forceNew?: boolean;
  timeZone?: string;
}

export interface ReplyOptions {
  signal?: AbortSignal;
}

/**
 * Everything the interface layer needs from AURA's mind. Implemented in-process by
 * `Brain` (Artifact and local modes) and over HTTP by the web app's RemoteBrain
 * (server mode), so the conversation loop never knows where the thinking happens.
 */
export interface BrainApi {
  loadProfile(): Promise<{ settings: UserSettings; persona: PersonaConfig }>;
  saveSettings(settings: UserSettings): Promise<UserSettings>;
  savePersona(persona: PersonaConfig): Promise<PersonaConfig>;

  startSession(opts?: SessionOptions): Promise<SessionInfo>;
  greet(sessionId: string, onEvent: (e: BrainEvent) => void, opts?: ReplyOptions): Promise<ReplyResult>;
  respond(sessionId: string, userText: string, onEvent: (e: BrainEvent) => void, opts?: ReplyOptions): Promise<ReplyResult>;
  /** Record how much of a reply was actually heard before the user cut in. */
  noteInterrupted(sessionId: string, turnId: string, spokenText: string): Promise<void>;
  endSession(sessionId: string): Promise<void>;

  listMemories(): Promise<MemoryItem[]>;
  addMemory(input: { content: string; kind?: MemoryKind; pinned?: boolean }): Promise<MemoryItem>;
  updateMemory(id: string, patch: { content?: string; kind?: MemoryKind; pinned?: boolean }): Promise<MemoryItem | null>;
  deleteMemory(id: string): Promise<void>;
  clearMemories(): Promise<void>;

  listConversations(limit?: number): Promise<ConversationMeta[]>;
  getConversation(id: string): Promise<{ meta: ConversationMeta; turns: Turn[] } | null>;
  deleteConversation(id: string): Promise<void>;
  clearConversations(): Promise<void>;

  exportAll(): Promise<ExportBundle>;
  /** Notified when background consolidation changes memory. */
  onMemoryChange(cb: (changes: MemoryChange[]) => void): () => void;
}

export interface BrainDeps {
  store: Store;
  llm: LlmClient;
  now?: () => number;
  logger?: Logger;
  /** Consolidate after this many unprocessed user turns (explicit "remember…" is immediate). */
  consolidateEvery?: number;
  /** Delay before background consolidation starts, so it never competes with a reply. */
  consolidateDelayMs?: number;
  /** A conversation idle for longer than this is not resumed. */
  resumeWindowMs?: number;
}

interface Session {
  meta: ConversationMeta;
  turns: Turn[];
  persisted: boolean;
  /** Private session: nothing stored, nothing learned. */
  ephemeral: boolean;
  /** Keep the transcript in history (off = memories may still be learned, the words are not kept). */
  keepTranscript: boolean;
  resumed: boolean;
  isFirstEver: boolean;
  timeZone?: string;
  timer?: ReturnType<typeof setTimeout>;
  consolidating?: Promise<void>;
}

const DEPTH_TIER: Record<UserSettings['conversation']['replyDepth'], LlmTier> = {
  fast: 'fast',
  balanced: 'balanced',
  deep: 'deep',
};

export class Brain implements BrainApi {
  private readonly store: Store;
  private llm: LlmClient;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly consolidateEvery: number;
  private readonly consolidateDelayMs: number;
  private readonly resumeWindowMs: number;
  private sessions = new Map<string, Session>();
  private listeners = new Set<(changes: MemoryChange[]) => void>();
  private profile?: { settings: UserSettings; persona: PersonaConfig };
  private memoryCache?: MemoryItem[];

  constructor(deps: BrainDeps) {
    this.store = deps.store;
    this.llm = deps.llm;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.logger ?? silentLogger;
    this.consolidateEvery = deps.consolidateEvery ?? 3;
    this.consolidateDelayMs = deps.consolidateDelayMs ?? 2500;
    this.resumeWindowMs = deps.resumeWindowMs ?? 30 * 60 * 1000;
  }

  /** Swap the language model at runtime (e.g. the user connects a different provider). */
  setLlm(llm: LlmClient) {
    this.llm = llm;
  }

  get llmId(): string {
    return this.llm.id;
  }

  // ── profile ──

  async loadProfile() {
    if (!this.profile) {
      const [s, p] = await Promise.all([this.store.getSettings(), this.store.getPersona()]);
      this.profile = {
        settings: s ? normalizeSettings(s) : structuredClone(DEFAULT_SETTINGS),
        persona: p ? normalizePersona(p) : structuredClone(DEFAULT_PERSONA),
      };
    }
    return structuredClone(this.profile);
  }

  async saveSettings(settings: UserSettings) {
    const clean = normalizeSettings(settings);
    await this.store.saveSettings(clean);
    const profile = await this.loadProfile();
    this.profile = { ...profile, settings: clean };
    return structuredClone(clean);
  }

  async savePersona(persona: PersonaConfig) {
    const clean = normalizePersona(persona);
    await this.store.savePersona(clean);
    const profile = await this.loadProfile();
    this.profile = { ...profile, persona: clean };
    return structuredClone(clean);
  }

  // ── memory (user-controlled) ──

  private async memories(): Promise<MemoryItem[]> {
    if (!this.memoryCache) this.memoryCache = await this.store.listMemories();
    return this.memoryCache;
  }

  private emit(changes: MemoryChange[]) {
    if (!changes.length) return;
    for (const cb of this.listeners) {
      try {
        cb(changes);
      } catch (err) {
        this.log.warn('memory listener failed', err);
      }
    }
  }

  onMemoryChange(cb: (changes: MemoryChange[]) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async listMemories() {
    return structuredClone(await this.memories()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async addMemory(input: { content: string; kind?: MemoryKind; pinned?: boolean }) {
    if (looksLikeCredential(input.content)) {
      throw new Error('That looks like a password or card number. AURA does not store credentials.');
    }
    const m = newMemory(
      { content: input.content, kind: input.kind ?? 'fact', pinned: input.pinned, origin: 'user', confidence: 1, importance: 0.8 },
      this.now(),
    );
    if (m.content.length < 3) throw new Error('A memory needs a few words.');
    const list = await this.memories(); // load before writing, or the new item would be counted twice
    await this.store.saveMemories({ upsert: [m] });
    list.push(m);
    this.emit([{ type: 'added', id: m.id, memory: m }]);
    return structuredClone(m);
  }

  async updateMemory(id: string, patch: { content?: string; kind?: MemoryKind; pinned?: boolean }) {
    const list = await this.memories();
    const idx = list.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    const cur = list[idx]!;
    const next: MemoryItem = { ...cur };
    if (typeof patch.content === 'string') {
      const content = patch.content.replace(/\s+/g, ' ').trim().slice(0, 260);
      if (content.length >= 3 && content !== cur.content) {
        if (looksLikeCredential(content)) throw new Error('AURA does not store credentials.');
        next.history = [...cur.history, { content: cur.content, at: cur.updatedAt, reason: 'edited by you' }].slice(-5);
        next.content = content;
        next.origin = 'user';
        next.confidence = 1;
        next.updatedAt = this.now();
      }
    }
    if (patch.kind) next.kind = patch.kind;
    if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned;
    await this.store.saveMemories({ upsert: [next] });
    list[idx] = next;
    this.emit([{ type: 'updated', id, memory: next }]);
    return structuredClone(next);
  }

  async deleteMemory(id: string) {
    const list = await this.memories();
    const idx = list.findIndex((m) => m.id === id);
    await this.store.saveMemories({ remove: [id] });
    if (idx !== -1) {
      const [gone] = list.splice(idx, 1);
      this.emit([{ type: 'deleted', id, memory: gone }]);
    }
  }

  async clearMemories() {
    await this.store.clearMemories();
    const gone = this.memoryCache ?? [];
    this.memoryCache = [];
    this.emit(gone.map((m) => ({ type: 'deleted' as const, id: m.id, memory: m })));
  }

  // ── history ──

  async listConversations(limit = 50) {
    return this.store.listConversations(limit);
  }

  async getConversation(id: string) {
    const live = this.sessions.get(id);
    if (live && !live.persisted) return { meta: { ...live.meta }, turns: structuredClone(live.turns) };
    const meta = await this.store.getConversation(id);
    if (!meta) return null;
    return { meta, turns: await this.store.getTurns(id) };
  }

  async deleteConversation(id: string) {
    const s = this.sessions.get(id);
    if (s?.timer) clearTimeout(s.timer);
    this.sessions.delete(id);
    await this.store.deleteConversation(id);
  }

  async clearConversations() {
    for (const s of this.sessions.values()) if (s.timer) clearTimeout(s.timer);
    this.sessions.clear();
    await this.store.clearConversations();
  }

  async exportAll(): Promise<ExportBundle> {
    const { settings, persona } = await this.loadProfile();
    const metas = await this.store.listConversations(1000);
    const conversations = [];
    for (const meta of metas) conversations.push({ meta, turns: await this.store.getTurns(meta.id) });
    return {
      exportedAt: new Date(this.now()).toISOString(),
      app: 'aura',
      version: 1,
      settings,
      persona,
      memories: await this.listMemories(),
      conversations,
    };
  }

  // ── sessions ──

  async startSession(opts: SessionOptions = {}): Promise<SessionInfo> {
    const now = this.now();
    const { settings } = await this.loadProfile();
    const ephemeral = opts.ephemeral === true;
    const recent = await this.store.listConversations(1);
    const memories = await this.memories();
    const last = recent[0];
    const isFirstEver = !last && memories.length === 0;

    if (last && !ephemeral && !opts.forceNew && settings.memory.saveTranscripts && now - last.updatedAt < this.resumeWindowMs) {
      let session = this.sessions.get(last.id);
      if (!session) {
        session = {
          meta: last,
          turns: await this.store.getTurns(last.id),
          persisted: true,
          ephemeral: false,
          keepTranscript: true,
          resumed: true,
          isFirstEver: false,
        };
        this.sessions.set(last.id, session);
      }
      session.resumed = true;
      session.timeZone = opts.timeZone;
      return { sessionId: last.id, resumed: true, isFirstEver: false, turns: structuredClone(session.turns) };
    }

    // An earlier conversation may have ended without its final consolidation (tab closed).
    if (last && last.consolidatedTurns < last.turnCount && !this.sessions.has(last.id)) {
      void this.catchUp(last).catch((err) => this.log.warn('catch-up consolidation failed', err));
    }

    const meta: ConversationMeta = {
      id: uid('conv_'),
      title: 'New conversation',
      summary: '',
      startedAt: now,
      updatedAt: now,
      turnCount: 0,
      consolidatedTurns: 0,
    };
    this.sessions.set(meta.id, {
      meta,
      turns: [],
      persisted: false,
      ephemeral,
      keepTranscript: !ephemeral && settings.memory.saveTranscripts,
      resumed: false,
      isFirstEver,
      timeZone: opts.timeZone,
    });
    return { sessionId: meta.id, resumed: false, isFirstEver, turns: [] };
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Unknown session. Start a conversation first.');
    return s;
  }

  private async persistTurns(s: Session, turns: Turn[]) {
    s.turns.push(...turns);
    s.meta.turnCount = s.turns.length;
    s.meta.updatedAt = this.now();
    if (!s.keepTranscript) return;
    try {
      await this.store.putConversation(s.meta);
      s.persisted = true;
      await this.store.appendTurns(s.meta.id, turns);
    } catch (err) {
      // Storage problems must never break the conversation itself.
      this.log.error('could not save conversation', err);
    }
  }

  async greet(sessionId: string, onEvent: (e: BrainEvent) => void, opts: ReplyOptions = {}): Promise<ReplyResult> {
    const s = this.session(sessionId);
    const memories = await this.memories();
    const cue = greetingCue({ isFirstEver: s.isFirstEver, resumed: s.resumed && s.turns.length > 0, hasMemories: memories.length > 0 });
    return this.generate(s, cue, undefined, onEvent, opts);
  }

  async respond(sessionId: string, userText: string, onEvent: (e: BrainEvent) => void, opts: ReplyOptions = {}): Promise<ReplyResult> {
    const s = this.session(sessionId);
    const text = userText.replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!text) throw new Error('Nothing to respond to.');
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = undefined;
    }
    // A retry after a failed reply must not duplicate the user's words.
    const lastTurn = s.turns[s.turns.length - 1];
    let userTurn: Turn;
    if (lastTurn && lastTurn.role === 'user' && lastTurn.text === text) {
      userTurn = lastTurn;
    } else {
      const lang = detectLanguage(text);
      userTurn = { id: uid('t_'), conversationId: s.meta.id, role: 'user', text, lang: lang === 'en' ? 'en' : 'bn', createdAt: this.now() };
      await this.persistTurns(s, [userTurn]);
    }
    const result = await this.generate(s, undefined, userTurn, onEvent, opts);
    this.scheduleConsolidation(s, hasExplicitMemoryCommand(text));
    return result;
  }

  private async generate(
    s: Session,
    cue: string | undefined,
    userTurn: Turn | undefined,
    onEvent: (e: BrainEvent) => void,
    opts: ReplyOptions,
  ): Promise<ReplyResult> {
    const now = this.now();
    const { settings, persona } = await this.loadProfile();
    // Switching learning off stops new memories; what is already remembered stays in use until deleted.
    const allMemories = await this.memories();
    const query = [userTurn?.text ?? '', ...s.turns.slice(-3).map((t) => t.text)].join(' ');
    const selected = selectMemories(allMemories, query, { now });
    const previous = (await this.store.listConversations(6)).filter((c) => c.id !== s.meta.id);
    const { messages, omitted } = buildMessages(s.turns);
    if (cue) messages.push({ role: 'user', content: cue });
    if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') {
      messages.push({ role: 'user', content: '(They are waiting for you to continue.)' });
    }

    const system = compilePersona(persona, { language: settings.language });
    const context = buildContext({
      now,
      timeZone: s.timeZone,
      displayName: settings.displayName,
      memories: selected,
      previous,
      current: { summary: s.meta.summary, olderTurnsOmitted: omitted },
      isFirstEver: s.isFirstEver,
    });

    const parser = new ReplyStreamParser();
    const chunker = new SentenceChunker();
    let text = '';
    let mood: Mood | undefined;
    let sentenceIndex = 0;
    const handle = (events: ReturnType<ReplyStreamParser['push']>) => {
      for (const e of events) {
        if (e.type === 'mood') {
          mood ??= e.mood;
          onEvent({ type: 'mood', mood: e.mood });
        } else {
          text += e.delta;
          onEvent({ type: 'delta', text: e.delta });
          for (const sentence of chunker.push(e.delta)) onEvent({ type: 'sentence', text: sentence, index: sentenceIndex++ });
        }
      }
    };

    let aborted = false;
    try {
      await this.llm.stream(
        {
          system,
          context,
          messages,
          tier: DEPTH_TIER[settings.conversation.replyDepth],
          purpose: 'chat',
          maxOutputTokens: 1200,
          signal: opts.signal,
        },
        (delta) => handle(parser.push(delta)),
      );
    } catch (err) {
      if (isAbort(err) || opts.signal?.aborted) aborted = true;
      else if (!(err instanceof LlmError) || !text.trim()) throw err;
      // A failure after some text: keep what we have rather than lose the turn.
      else this.log.warn('reply ended early', { code: (err as LlmError).code });
    }
    if (!aborted) {
      handle(parser.end());
      for (const sentence of chunker.flush()) onEvent({ type: 'sentence', text: sentence, index: sentenceIndex++ });
    }
    text = text.trim();
    const finalMood = mood ?? guessMood(text);
    if (!mood && text) onEvent({ type: 'mood', mood: finalMood });

    if (!text) {
      if (aborted) return { text: '', mood: finalMood, userTurnId: userTurn?.id, aborted: true };
      throw new LlmError('bad_response', 'The model returned an empty reply.');
    }
    const turn: Turn = {
      id: uid('t_'),
      conversationId: s.meta.id,
      role: 'assistant',
      text,
      mood: finalMood,
      lang: detectLanguage(text) === 'en' ? 'en' : 'bn',
      createdAt: this.now(),
      interrupted: aborted || undefined,
    };
    await this.persistTurns(s, [turn]);
    return { text, mood: finalMood, turnId: turn.id, userTurnId: userTurn?.id, aborted };
  }

  async noteInterrupted(sessionId: string, turnId: string, spokenText: string) {
    const s = this.sessions.get(sessionId);
    const turn = s?.turns.find((t) => t.id === turnId);
    if (!s || !turn) return;
    turn.text = spokenText.trim();
    turn.interrupted = true;
    if (s.keepTranscript && s.persisted) {
      try {
        await this.store.updateTurn(s.meta.id, turnId, { text: turn.text, interrupted: true });
      } catch (err) {
        this.log.warn('could not record interruption', err);
      }
    }
  }

  async endSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = undefined;
    }
    s.meta.endedAt = this.now();
    await this.consolidate(s, true).catch((err) => this.log.warn('final consolidation failed', err));
    if (s.keepTranscript && s.persisted) {
      await this.store.putConversation(s.meta).catch((err) => this.log.warn('could not close conversation', err));
    }
    if (!s.keepTranscript) this.sessions.delete(sessionId);
  }

  // ── consolidation: learn memories, refresh the running summary ──

  private scheduleConsolidation(s: Session, urgent: boolean) {
    if (s.ephemeral) return;
    const pendingUserTurns = s.turns.slice(s.meta.consolidatedTurns).filter((t) => t.role === 'user').length;
    if (!urgent && pendingUserTurns < this.consolidateEvery) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = undefined;
      void this.consolidate(s, false).catch((err) => this.log.warn('consolidation failed', err));
    }, this.consolidateDelayMs);
  }

  /** Await any consolidation in flight or scheduled (used by tests and by session end). */
  async flush(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = undefined;
      await this.consolidate(s, false);
    } else if (s.consolidating) {
      await s.consolidating;
    }
  }

  private consolidate(s: Session, final: boolean): Promise<void> {
    const run = async () => {
      if (s.ephemeral) return;
      const pending = s.turns.slice(s.meta.consolidatedTurns);
      if (!pending.some((t) => t.role === 'user')) return;
      const { settings, persona } = await this.loadProfile();
      const learn = settings.memory.enabled;
      const substantive = worthCurating(pending);
      // A summary is only worth a model call once there is a real conversation to summarise.
      const needSummary = s.keepTranscript && worthCurating(s.turns) && (final || pending.length >= 12);
      if (!(learn && substantive) && !needSummary) return;
      const upTo = s.turns.length;
      const existing = learn ? await this.memories() : [];
      const prompt = buildCuratorPrompt({
        companionName: persona.name,
        existing,
        turns: pending.slice(-40),
        previousSummary: s.meta.summary,
        now: this.now(),
        timeZone: s.timeZone,
        learn,
        allowSensitive: settings.memory.allowSensitive,
      });
      const res = await this.llm.stream(
        { system: prompt.system, messages: [{ role: 'user', content: prompt.user }], tier: 'fast', purpose: 'extract', maxOutputTokens: 1500 },
        () => {},
      );
      const curated = parseCuration(res.text, prompt.aliases);
      if (learn && curated.ops.length) {
        const applied = applyMemoryOps(existing, curated.ops, {
          now: this.now(),
          allowSensitive: settings.memory.allowSensitive,
          conversationId: s.meta.id,
        });
        if (applied.upsert.length || applied.remove.length) {
          await this.store.saveMemories({ upsert: applied.upsert, remove: applied.remove });
          const next = new Map((await this.memories()).map((m) => [m.id, m] as const));
          for (const id of applied.remove) next.delete(id);
          for (const m of applied.upsert) next.set(m.id, m);
          this.memoryCache = [...next.values()];
        }
        this.emit(applied.changes.filter((c) => c.type !== 'skipped'));
        this.log.info('memory consolidated', {
          added: applied.changes.filter((c) => c.type === 'added').length,
          updated: applied.changes.filter((c) => c.type === 'updated').length,
          deleted: applied.changes.filter((c) => c.type === 'deleted').length,
          skipped: applied.changes.filter((c) => c.type === 'skipped').length,
        });
      }
      if (curated.summary) s.meta.summary = curated.summary;
      if (curated.title && (s.meta.title === 'New conversation' || final)) s.meta.title = curated.title;
      s.meta.consolidatedTurns = upTo;
      if (s.persisted) await this.store.putConversation(s.meta);
    };
    const chained: Promise<void> = (s.consolidating ?? Promise.resolve()).catch(() => {}).then(run);
    const tracked: Promise<void> = chained
      .catch(() => {})
      .finally(() => {
        if (s.consolidating === tracked) s.consolidating = undefined;
      });
    s.consolidating = tracked;
    return chained;
  }

  private async catchUp(meta: ConversationMeta) {
    const turns = await this.store.getTurns(meta.id);
    const s: Session = { meta: { ...meta }, turns, persisted: true, ephemeral: false, keepTranscript: true, resumed: false, isFirstEver: false };
    await this.consolidate(s, true);
  }
}
