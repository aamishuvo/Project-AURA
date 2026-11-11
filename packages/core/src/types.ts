/**
 * Domain types shared by every AURA runtime (browser, Claude Artifact, server).
 */

export type Lang = 'en' | 'bn';

/** How AURA chooses the language she speaks. */
export type LanguageMode = 'auto' | 'en' | 'bn' | 'mixed';

export const MOODS = [
  'neutral',
  'warm',
  'curious',
  'playful',
  'amused',
  'thoughtful',
  'concerned',
  'excited',
  'calm',
  'serious',
  'sad',
  'surprised',
] as const;
export type Mood = (typeof MOODS)[number];

export type Role = 'user' | 'assistant';

export interface Turn {
  id: string;
  conversationId: string;
  role: Role;
  text: string;
  /** Mood AURA expressed while saying this (assistant turns only). */
  mood?: Mood;
  lang?: Lang;
  createdAt: number;
  /** The user cut AURA off; `text` holds only what was actually heard. */
  interrupted?: boolean;
}

export interface ConversationMeta {
  id: string;
  title: string;
  /** Rolling summary, refreshed by consolidation. */
  summary: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  turnCount: number;
  /** Number of turns already seen by memory consolidation. */
  consolidatedTurns: number;
}

export const MEMORY_KINDS = [
  'identity',
  'preference',
  'fact',
  'project',
  'goal',
  'relationship',
  'event',
  'topic',
  'rapport',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryRevision {
  content: string;
  at: number;
  reason?: string;
}

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  /** One self-contained sentence in the third person ("Their name is Shuvo."). */
  content: string;
  /** 0..1 — how much this should shape future conversations. */
  importance: number;
  /** 0..1 — how sure we are (explicit statements are high, inferences low). */
  confidence: number;
  /** Health, money, beliefs, intimate details… stored only with consent. */
  sensitive: boolean;
  /** Pinned by the user: always in context, never auto-edited. */
  pinned: boolean;
  /** 'user' when typed or edited in the memory panel, 'conversation' when learned. */
  origin: 'conversation' | 'user';
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  /** Earlier versions, newest last — kept when a contradiction replaces content. */
  history: MemoryRevision[];
  sourceConversationId?: string;
}

export type ReplyDepth = 'fast' | 'balanced' | 'deep';

export interface UserSettings {
  version: 1;
  language: LanguageMode;
  /** What AURA calls the user, if they set it by hand. Memory can also supply it. */
  displayName: string;
  conversation: {
    /** Start listening again as soon as AURA finishes speaking (where the platform allows). */
    autoListen: boolean;
    /** 'voice' = speaking over AURA interrupts her; 'tap' = only a tap or key press does. */
    bargeIn: 'voice' | 'tap';
    greetOnStart: boolean;
    captions: boolean;
    /** Silence (ms) after the last word before a turn is considered finished. */
    endpointMs: number;
    replyDepth: ReplyDepth;
  };
  voice: {
    muted: boolean;
    /** Playback rate multiplier, 0.7 – 1.5. */
    rate: number;
    /** -1 (lower) … 1 (higher); engines that cannot pitch-shift ignore it. */
    pitch: number;
    /** Preferred voice for the hosted Claude voice engine. */
    claudeVoice: string;
  };
  avatar: {
    look: string;
    /** CSS hue in degrees, or 'mood' to follow the emotional tone. */
    aura: number | 'mood';
    motion: 'full' | 'reduced';
  };
  memory: {
    /** Learn long-term memories from conversations. */
    enabled: boolean;
    /** Keep transcripts so past conversations can be reviewed and summarised. */
    saveTranscripts: boolean;
    /** Allow storing sensitive details the user states (never inferred). */
    allowSensitive: boolean;
  };
}

export const DEFAULT_SETTINGS: UserSettings = {
  version: 1,
  language: 'auto',
  displayName: '',
  conversation: {
    autoListen: true,
    bargeIn: 'voice',
    greetOnStart: true,
    captions: true,
    endpointMs: 900,
    replyDepth: 'fast',
  },
  voice: { muted: false, rate: 1, pitch: 0, claudeVoice: 'airy' },
  avatar: { look: 'nila', aura: 'mood', motion: 'full' },
  memory: { enabled: true, saveTranscripts: true, allowSensitive: false },
};

/** Deep-merge stored settings over defaults so new fields get sane values. */
export function normalizeSettings(input: unknown): UserSettings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const d = DEFAULT_SETTINGS;
  const pick = <T>(v: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const c = src.conversation ?? {};
  const v = src.voice ?? {};
  const a = src.avatar ?? {};
  const m = src.memory ?? {};
  return {
    version: 1,
    language: pick(src.language, ['auto', 'en', 'bn', 'mixed'] as const, d.language),
    displayName: typeof src.displayName === 'string' ? src.displayName.slice(0, 60) : '',
    conversation: {
      autoListen: bool(c.autoListen, d.conversation.autoListen),
      bargeIn: pick(c.bargeIn, ['voice', 'tap'] as const, d.conversation.bargeIn),
      greetOnStart: bool(c.greetOnStart, d.conversation.greetOnStart),
      captions: bool(c.captions, d.conversation.captions),
      endpointMs: num(c.endpointMs, 400, 3000, d.conversation.endpointMs),
      replyDepth: pick(c.replyDepth, ['fast', 'balanced', 'deep'] as const, d.conversation.replyDepth),
    },
    voice: {
      muted: bool(v.muted, d.voice.muted),
      rate: num(v.rate, 0.7, 1.5, d.voice.rate),
      pitch: num(v.pitch, -1, 1, d.voice.pitch),
      claudeVoice: typeof v.claudeVoice === 'string' ? v.claudeVoice.slice(0, 24) : d.voice.claudeVoice,
    },
    avatar: {
      look: typeof a.look === 'string' ? a.look.slice(0, 24) : d.avatar.look,
      aura: a.aura === 'mood' ? 'mood' : typeof a.aura === 'number' ? num(a.aura, 0, 360, 250) : d.avatar.aura,
      motion: pick(a.motion, ['full', 'reduced'] as const, d.avatar.motion),
    },
    memory: {
      enabled: bool(m.enabled, d.memory.enabled),
      saveTranscripts: bool(m.saveTranscripts, d.memory.saveTranscripts),
      allowSensitive: bool(m.allowSensitive, d.memory.allowSensitive),
    },
  };
}

/** Everything a user can take with them. */
export interface ExportBundle {
  exportedAt: string;
  app: 'aura';
  version: 1;
  settings: UserSettings;
  persona: unknown;
  memories: MemoryItem[];
  conversations: Array<{ meta: ConversationMeta; turns: Turn[] }>;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
