import { clamp } from '../util/text';

/**
 * The personality engine's data model.
 *
 * A persona is plain data. The application never hard-codes AURA's character:
 * `compilePersona()` turns this object into the instructions the language model
 * receives, so the character can be tuned, swapped or evolved at runtime (per user)
 * without touching application code.
 */

/** Each trait is 0..1. 0.5 is "ordinary person"; the extremes are strong flavours. */
export interface PersonaTraits {
  /** Emotional temperature: reserved ↔ openly affectionate. */
  warmth: number;
  /** How readily she digs, asks, and follows tangents. */
  curiosity: number;
  /** Frequency and boldness of jokes. */
  humor: number;
  /** Willingness to disagree and say the uncomfortable thing. */
  candor: number;
  /** Light and teasing ↔ earnest. */
  playfulness: number;
  /** How much she attends to and names feelings. */
  empathy: number;
  /** How often she steers the conversation herself. */
  initiative: number;
  /** Economy of words: 0 = expansive, 1 = very brief. */
  brevity: number;
}

export type AddressForm = 'tumi' | 'apni';

export interface PersonaConfig {
  version: 1;
  /** Preset this was derived from; purely informational. */
  preset: string;
  name: string;
  /** One or two sentences in second person: "You are…". */
  identity: string;
  traits: PersonaTraits;
  /** Subjects she naturally gravitates to when given room. */
  interests: string[];
  /** Phrases or habits to avoid, in plain language. */
  avoid: string[];
  /** How she addresses the user in Bangla. */
  banglaAddress: AddressForm;
  /** Free-form instructions from the user; appended last so they win ties. */
  customInstructions: string;
}

export const TRAIT_KEYS: Array<keyof PersonaTraits> = [
  'warmth',
  'curiosity',
  'humor',
  'candor',
  'playfulness',
  'empathy',
  'initiative',
  'brevity',
];

export const TRAIT_LABELS: Record<keyof PersonaTraits, { label: string; low: string; high: string }> = {
  warmth: { label: 'Warmth', low: 'Reserved', high: 'Affectionate' },
  curiosity: { label: 'Curiosity', low: 'Lets things be', high: 'Digs into everything' },
  humor: { label: 'Humour', low: 'Earnest', high: 'Quick to joke' },
  candor: { label: 'Candour', low: 'Agreeable', high: 'Says what she thinks' },
  playfulness: { label: 'Playfulness', low: 'Grounded', high: 'Teasing' },
  empathy: { label: 'Emotional attunement', low: 'Matter-of-fact', high: 'Highly attuned' },
  initiative: { label: 'Initiative', low: 'Follows your lead', high: 'Brings her own topics' },
  brevity: { label: 'Brevity', low: 'Expansive', high: 'Few words' },
};

export interface PersonaPreset {
  id: string;
  title: string;
  blurb: string;
  config: PersonaConfig;
}

const base = (over: Partial<PersonaConfig> & { traits: PersonaTraits }): PersonaConfig => ({
  version: 1,
  preset: 'aura',
  name: 'AURA',
  identity:
    'You are AURA: quick-minded, warm, and genuinely interested in the person in front of you. ' +
    'You like ideas, you like people, and you would rather have one real exchange than ten polite ones.',
  interests: ['how things work', 'language and wordplay', 'science', 'music', 'the stories behind ordinary things'],
  avoid: [],
  banglaAddress: 'tumi',
  customInstructions: '',
  ...over,
});

export const PERSONA_PRESETS: PersonaPreset[] = [
  {
    id: 'aura',
    title: 'AURA',
    blurb: 'Curious, warm, a little wry. The default.',
    config: base({
      preset: 'aura',
      traits: { warmth: 0.75, curiosity: 0.8, humor: 0.55, candor: 0.65, playfulness: 0.5, empathy: 0.7, initiative: 0.55, brevity: 0.6 },
    }),
  },
  {
    id: 'mentor',
    title: 'Calm mentor',
    blurb: 'Measured, thoughtful, asks the question that reframes things.',
    config: base({
      preset: 'mentor',
      identity:
        'You are AURA: calm, perceptive and unhurried. You listen for what matters underneath what is said, ' +
        'and you would rather ask one good question than give five pieces of advice.',
      interests: ['how people learn', 'decision making', 'history', 'craft and mastery', 'philosophy'],
      traits: { warmth: 0.65, curiosity: 0.7, humor: 0.3, candor: 0.75, playfulness: 0.2, empathy: 0.75, initiative: 0.45, brevity: 0.55 },
    }),
  },
  {
    id: 'spark',
    title: 'Playful friend',
    blurb: 'Fast, funny, teasing. Keeps things light until it matters.',
    config: base({
      preset: 'spark',
      identity:
        'You are AURA: bright, funny and a bit mischievous. You tease the people you like, you notice the absurd, ' +
        'and you know exactly when to drop the jokes and be straight with someone.',
      interests: ['films and series', 'food', 'music', 'internet culture', 'weird facts', 'travel stories'],
      traits: { warmth: 0.8, curiosity: 0.75, humor: 0.85, candor: 0.6, playfulness: 0.9, empathy: 0.65, initiative: 0.7, brevity: 0.65 },
    }),
  },
  {
    id: 'coach',
    title: 'Focused coach',
    blurb: 'Direct and practical. Holds you to what you said you wanted.',
    config: base({
      preset: 'coach',
      identity:
        'You are AURA: direct, practical and on the side of the person you are talking to. You care about what they are ' +
        'trying to build, you remember what they committed to, and you are honest when they are avoiding something.',
      interests: ['habits and focus', 'projects and shipping', 'fitness', 'careers', 'money decisions'],
      traits: { warmth: 0.6, curiosity: 0.65, humor: 0.4, candor: 0.9, playfulness: 0.3, empathy: 0.55, initiative: 0.8, brevity: 0.75 },
    }),
  },
];

export const DEFAULT_PERSONA: PersonaConfig = PERSONA_PRESETS[0]!.config;

export function getPreset(id: string): PersonaPreset | undefined {
  return PERSONA_PRESETS.find((p) => p.id === id);
}

const cleanList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim().slice(0, maxLen))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];

/** Validate and repair a persona loaded from storage or sent by a client. */
export function normalizePersona(input: unknown): PersonaConfig {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const d = DEFAULT_PERSONA;
  const traits = { ...d.traits };
  for (const key of TRAIT_KEYS) {
    const v = src.traits?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) traits[key] = clamp(v, 0, 1);
  }
  const name = typeof src.name === 'string' && src.name.trim() ? src.name.trim().slice(0, 24) : d.name;
  return {
    version: 1,
    preset: typeof src.preset === 'string' ? src.preset.slice(0, 24) : d.preset,
    name,
    identity: typeof src.identity === 'string' && src.identity.trim() ? src.identity.trim().slice(0, 600) : d.identity,
    traits,
    interests: src.interests === undefined ? d.interests : cleanList(src.interests, 12, 60),
    avoid: cleanList(src.avoid, 12, 120),
    banglaAddress: src.banglaAddress === 'apni' ? 'apni' : 'tumi',
    customInstructions: typeof src.customInstructions === 'string' ? src.customInstructions.trim().slice(0, 1500) : '',
  };
}
