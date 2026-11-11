import type { ConversationMeta, MemoryItem, Turn } from '../types';
import type { ChatMessage } from '../llm/types';
import { formatMemoriesForPrompt } from '../memory/memory';
import { relativeTime } from '../util/text';

/** Short-term memory limits: what of the live conversation is replayed verbatim. */
export const SHORT_TERM_TURNS = 30;
export const SHORT_TERM_CHARS = 9000;

export interface ContextInput {
  now: number;
  timeZone?: string;
  displayName: string;
  memories: MemoryItem[];
  /** Earlier conversations, newest first, excluding the current one. */
  previous: ConversationMeta[];
  current: { summary: string; olderTurnsOmitted: boolean };
  isFirstEver: boolean;
}

function formatNow(now: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone,
    }).format(new Date(now));
  } catch {
    return new Date(now).toUTCString();
  }
}

/**
 * The per-turn context block: time, long-term memories, earlier conversations and
 * the running summary of this one. It changes between turns, so it is kept apart
 * from the persona text, which stays byte-stable.
 */
export function buildContext(input: ContextInput): string {
  const parts: string[] = [];
  const last = input.previous[0];
  const lastSeen = input.isFirstEver
    ? 'This is the first time you are talking with them.'
    : last
      ? `You last talked ${relativeTime(last.updatedAt, input.now)}.`
      : 'You have talked before.';
  parts.push(`# Right now\nIt is ${formatNow(input.now, input.timeZone)} where they are. ${lastSeen}`);

  const name = input.displayName.trim();
  parts.push(
    `# What you remember about them\n${name ? `- They asked to be called ${name}.\n` : ''}${formatMemoriesForPrompt(input.memories, input.now)}`,
  );

  const earlier = input.previous.filter((c) => c.summary).slice(0, 4);
  if (earlier.length) {
    parts.push(
      `# Earlier conversations\n${earlier.map((c) => `- ${relativeTime(c.updatedAt, input.now)}: ${c.summary}`).join('\n')}`,
    );
  }

  if (input.current.summary && input.current.olderTurnsOmitted) {
    parts.push(`# Earlier in this conversation\n${input.current.summary}`);
  }
  return parts.join('\n\n');
}

export const OPENING_CUE = '(They have just opened the conversation and are waiting for you to speak.)';

/**
 * Convert stored turns into the message list for the model: bounded, starting on a
 * user turn, with consecutive same-speaker turns merged and interruptions marked.
 */
export function buildMessages(turns: Turn[]): { messages: ChatMessage[]; omitted: boolean } {
  let window = turns.slice(-SHORT_TERM_TURNS);
  let chars = window.reduce((n, t) => n + t.text.length, 0);
  while (window.length > 2 && chars > SHORT_TERM_CHARS) {
    chars -= window[0]!.text.length;
    window = window.slice(1);
  }
  const omitted = window.length < turns.length;
  const messages: ChatMessage[] = [];
  for (const t of window) {
    const text = t.role === 'assistant' && t.interrupted ? `${t.text.replace(/[\s.…—-]+$/, '')}— [cut off]` : t.text;
    if (!text.trim()) continue;
    const prev = messages[messages.length - 1];
    if (prev && prev.role === t.role) prev.content += `\n${text}`;
    else messages.push({ role: t.role, content: text });
  }
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: OPENING_CUE });
  return { messages, omitted };
}

export function greetingCue(opts: { isFirstEver: boolean; resumed: boolean; hasMemories: boolean }): string {
  if (opts.isFirstEver) {
    return (
      '(They have just opened the conversation for the first time. Say hello in one or two short spoken sentences: ' +
      'your name, and an easy way in, such as asking what to call them. No list of what you can do.)'
    );
  }
  if (opts.resumed) {
    return '(They stepped away for a moment and are back. Pick the conversation up in one short sentence. Do not repeat yourself.)';
  }
  return (
    '(They have just come back to talk. Greet them in one or two short spoken sentences. ' +
    (opts.hasMemories
      ? 'If something in your memory is worth picking up, such as a project, a plan or something they were looking forward to, you may ask about it lightly. Otherwise a simple, warm hello and an easy opening. '
      : 'A simple, warm hello and an easy opening. ') +
    'Do not introduce yourself again.)'
  );
}
