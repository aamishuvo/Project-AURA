import type { ConversationMeta, MemoryItem, Turn, UserSettings } from '../types';
import type { PersonaConfig } from '../persona/persona';

/**
 * Persistence for ONE user. Every implementation is already scoped to the signed-in
 * person, so nothing in the brain can address another user's data.
 *
 * Implementations: in-memory (tests), IndexedDB (local mode), the Claude Artifact
 * database (hosted mode) and PostgreSQL (server mode).
 */
export interface Store {
  /** Human-readable name for diagnostics ("postgres", "artifact-db", "indexeddb", "memory"). */
  readonly kind: string;

  getSettings(): Promise<UserSettings | null>;
  saveSettings(settings: UserSettings): Promise<void>;

  getPersona(): Promise<PersonaConfig | null>;
  savePersona(persona: PersonaConfig): Promise<void>;

  listMemories(): Promise<MemoryItem[]>;
  /** Insert or replace by id, and delete by id, in one step. */
  saveMemories(change: { upsert?: MemoryItem[]; remove?: string[] }): Promise<void>;
  clearMemories(): Promise<void>;

  /** Newest first. */
  listConversations(limit: number): Promise<ConversationMeta[]>;
  getConversation(id: string): Promise<ConversationMeta | null>;
  putConversation(meta: ConversationMeta): Promise<void>;
  /** Oldest first; `limit` keeps only the most recent N. */
  getTurns(conversationId: string, limit?: number): Promise<Turn[]>;
  appendTurns(conversationId: string, turns: Turn[]): Promise<void>;
  updateTurn(conversationId: string, turnId: string, patch: Partial<Pick<Turn, 'text' | 'interrupted' | 'mood'>>): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  clearConversations(): Promise<void>;
}

/** Volatile store: used by tests and as the last-resort fallback when nothing can persist. */
export class MemoryStore implements Store {
  readonly kind: string = 'memory';
  private settings: UserSettings | null = null;
  private persona: PersonaConfig | null = null;
  private memories = new Map<string, MemoryItem>();
  private conversations = new Map<string, ConversationMeta>();
  private turns = new Map<string, Turn[]>();

  async getSettings() {
    return this.settings ? structuredClone(this.settings) : null;
  }
  async saveSettings(settings: UserSettings) {
    this.settings = structuredClone(settings);
  }
  async getPersona() {
    return this.persona ? structuredClone(this.persona) : null;
  }
  async savePersona(persona: PersonaConfig) {
    this.persona = structuredClone(persona);
  }
  async listMemories() {
    return [...this.memories.values()].map((m) => structuredClone(m));
  }
  async saveMemories(change: { upsert?: MemoryItem[]; remove?: string[] }) {
    for (const id of change.remove ?? []) this.memories.delete(id);
    for (const m of change.upsert ?? []) this.memories.set(m.id, structuredClone(m));
  }
  async clearMemories() {
    this.memories.clear();
  }
  async listConversations(limit: number) {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }
  async getConversation(id: string) {
    const c = this.conversations.get(id);
    return c ? { ...c } : null;
  }
  async putConversation(meta: ConversationMeta) {
    this.conversations.set(meta.id, { ...meta });
  }
  async getTurns(conversationId: string, limit?: number) {
    const all = this.turns.get(conversationId) ?? [];
    return (limit ? all.slice(-limit) : all).map((t) => ({ ...t }));
  }
  async appendTurns(conversationId: string, turns: Turn[]) {
    const list = this.turns.get(conversationId) ?? [];
    list.push(...turns.map((t) => ({ ...t })));
    this.turns.set(conversationId, list);
  }
  async updateTurn(conversationId: string, turnId: string, patch: Partial<Pick<Turn, 'text' | 'interrupted' | 'mood'>>) {
    const t = this.turns.get(conversationId)?.find((x) => x.id === turnId);
    if (t) Object.assign(t, patch);
  }
  async deleteConversation(id: string) {
    this.conversations.delete(id);
    this.turns.delete(id);
  }
  async clearConversations() {
    this.conversations.clear();
    this.turns.clear();
  }
}
