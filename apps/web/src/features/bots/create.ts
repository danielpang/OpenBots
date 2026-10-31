import { unwrap, type components } from '@openbot/api-client';
import { shuffle, type AvatarParams } from '@openbot/avatars';
import type { SchedulePreset, ToolGroupName, ToolPolicy } from '@openbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../app/api.js';
import { turnedOff } from '../tools/policy.js';
import { botsQuery, takenAvatars } from './queries.js';

// Creating a Bot from New (B2). The guided answers become standing rules in
// the description (B3), where the owner can read and edit them later; the
// connectors picked at "Tools and sources" become its connector permissions
// (T1), editable in Settings; the optional recurring schedule becomes its
// first Routine (R1), editable on the Routines tab. The approval boundary is
// a standing rule too, which the model reads; the tool groups ticked beside
// it are enforced, written to the Bot's tool policy (T5) as "Ask first",
// where the tools tab shows and edits them. All of it goes in one
// `POST /bots`, which creates everything or nothing, so pressing Create again
// after an error never makes a second Bot.

type CreateBot = components['schemas']['CreateBot'];

export interface GuidedAnswers {
  goal: string;
  tools: string;
  style: string;
  approval: string;
}

export const GUIDED_STEPS = [
  {
    key: 'goal',
    title: 'Goal or area of ownership',
    prompt: 'What is this Bot responsible for?',
    placeholder: 'Keep the support inbox triaged and flag anything urgent.',
    rule: 'Goal',
  },
  {
    key: 'tools',
    title: 'Tools and sources',
    prompt: 'Which tools and sources should it work from?',
    placeholder: 'The support inbox, the product docs, the status page.',
    rule: 'Tools and sources',
  },
  {
    key: 'style',
    title: 'Working style',
    prompt: 'How should it work and report back?',
    placeholder: 'Short updates, bullet points, no small talk.',
    rule: 'Working style',
  },
  {
    key: 'approval',
    title: 'Approval boundary',
    prompt: 'What must it ask you before doing?',
    placeholder: 'Ask before replying to a customer or closing a ticket.',
    rule: 'Ask first',
  },
] as const satisfies readonly {
  key: keyof GuidedAnswers;
  title: string;
  prompt: string;
  placeholder: string;
  rule: string;
}[];

/**
 * Tool groups the approval step can make ask first (T5), on top of the
 * defaults. Only groups the Bot tools tab edits, so the owner can see and
 * undo the choice there.
 */
export const ASK_FIRST_GROUPS = [
  { group: 'connector', label: 'Every connector tool, even ones that only read' },
  { group: 'builtin', label: 'Every built-in tool, such as web search and web fetch' },
] as const satisfies readonly { group: ToolGroupName; label: string }[];

export type AskFirstGroup = (typeof ASK_FIRST_GROUPS)[number]['group'];

/** What every Bot asks before anyway, as the approval step says it (the engine's defaults). */
export const ASKS_BY_DEFAULT =
  'It already asks before sending email, running commands or changing data.';

/** The tool policy for the groups ticked at the approval step; undefined for none. */
export function askFirstPolicy(groups: readonly AskFirstGroup[]): ToolPolicy | undefined {
  if (!groups.length) return undefined;
  return { groups: Object.fromEntries(groups.map((group) => [group, 'ask' as const])) };
}

/** The optional last step of guided creation (B2): what to do, and when. */
export interface GuidedSchedule {
  preset: SchedulePreset;
  prompt: string;
  timezone: string;
}

/** A name for the first Routine from what it does: its first line, shortened. */
export function scheduleRoutineName(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'Recurring work';
}

/** The `POST /bots/{id}/routines` body for the schedule step. */
export function scheduleRoutineBody(schedule: GuidedSchedule) {
  return {
    name: scheduleRoutineName(schedule.prompt),
    prompt: schedule.prompt.trim(),
    trigger: { type: 'schedule' as const, preset: schedule.preset },
    timezone: schedule.timezone,
  };
}

/** One `Rule: answer` line per answered step, in step order; unanswered steps leave no line. */
export function guidedDescription(answers: Partial<GuidedAnswers>): string {
  return GUIDED_STEPS.flatMap((step) => {
    const answer = answers[step.key]?.trim();
    return answer ? [`${step.rule}: ${answer}`] : [];
  }).join('\n');
}

/** The `POST /bots` body for a name and the guided answers, with an avatar unlike `taken`. */
export function createBotBody(
  name: string,
  answers: Partial<GuidedAnswers> = {},
  taken: readonly AvatarParams[] = [],
  seed: string = crypto.randomUUID(),
): CreateBot {
  // The tools answer stays a rule in the description; the connectors picked
  // beside it are written as the Bot's connector permissions after creation.
  const description = guidedDescription(answers);
  return {
    name: name.trim(),
    avatar: shuffle(seed, taken),
    ...(description ? { description } : {}),
  };
}

export interface NewBot {
  name: string;
  answers?: Partial<GuidedAnswers>;
  /** Connectors this Bot may not use; every other one stays on (T1). */
  connectorsOff?: readonly string[];
  /** Tool groups that always ask first, from the approval step (T5). */
  askFirst?: readonly AskFirstGroup[];
  /** The first Routine, from the recurring-schedule step. */
  schedule?: GuidedSchedule | null;
}

/**
 * The single `POST /bots` body for New: the Bot with its tool policy,
 * connector settings and first Routine.
 */
export function newBotBody(
  { name, answers, connectorsOff = [], askFirst = [], schedule }: NewBot,
  taken: readonly AvatarParams[] = [],
  seed?: string,
): CreateBot {
  const toolPolicy = askFirstPolicy(askFirst);
  return {
    ...createBotBody(name, answers, taken, seed),
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(connectorsOff.length ? { connectors: turnedOff(connectorsOff) } : {}),
    ...(schedule ? { routine: scheduleRoutineBody(schedule) } : {}),
  };
}

export function useCreateBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewBot) => {
      const roster = await queryClient.ensureQueryData(botsQuery);
      const body = newBotBody(input, takenAvatars(roster.items));
      return unwrap(api.POST('/api/v1/bots', { body }));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: botsQuery.queryKey }),
  });
}
