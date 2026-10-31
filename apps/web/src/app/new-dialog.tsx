import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from '@openbot/ui';
import { browserTimezone } from '@openbot/widgets/react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  ASK_FIRST_GROUPS,
  ASKS_BY_DEFAULT,
  GUIDED_STEPS,
  useCreateBot,
  type AskFirstGroup,
  type GuidedAnswers,
  type GuidedSchedule,
} from '../features/bots/create.js';
import { botsQuery } from '../features/bots/queries.js';
import { GROUP_MIN } from '../features/chats/api.js';
import { NewChat } from '../features/chats/new-chat.js';
import {
  DEFAULT_DRAFT,
  presetFromDraft,
  type ScheduleDraft,
} from '../features/routines/schedule.js';
import { ScheduleFields } from '../features/routines/schedule-fields.js';
import { FromTemplate } from '../features/templates/template-list.js';
import { connectorsQuery } from '../features/tools/api.js';

// New (Cmd/Ctrl+N in the Mac app, Alt+N in a browser, B2): create a Bot,
// guided or by name alone, or start a group chat with two to six of them (C4),
// or create one from a template (B6). The guided path ends with an optional
// recurring schedule, which becomes the Bot's first Routine (R1).

export function NewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Remounted on every open, so each New starts from the first screen. */}
        {open && <NewFlow onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

type Mode =
  { kind: 'choose' } | { kind: 'guided'; step: number } | { kind: 'chat' } | { kind: 'template' };

export function NewFlow({
  onDone,
  initial = { kind: 'choose' },
}: {
  onDone(): void;
  initial?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initial);
  const [name, setName] = useState('');
  const [answers, setAnswers] = useState<Partial<GuidedAnswers>>({});
  // Every connector is on for a new Bot (T1) until the owner unticks one.
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  // Tool groups the owner wants asked about every time (T5), beyond the defaults.
  const [askFirst, setAskFirst] = useState<ReadonlySet<AskFirstGroup>>(new Set());
  // The recurring-schedule step: off unless the owner turns it on.
  const [scheduled, setScheduled] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft>(DEFAULT_DRAFT);
  const [routinePrompt, setRoutinePrompt] = useState('');
  const [timezone] = useState(browserTimezone);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const connectors = useQuery(connectorsQuery);
  const bots = useQuery(botsQuery);
  const create = useCreateBot();
  const navigate = useNavigate();

  const start = (guided: boolean, schedule: GuidedSchedule | null = null) =>
    create.mutate(
      {
        name,
        ...(guided ? { answers } : {}),
        ...(guided ? { connectorsOff: [...off], askFirst: [...askFirst] } : {}),
        ...(schedule ? { schedule } : {}),
      },
      {
        onSuccess: (bot) => {
          onDone();
          void navigate({ to: '/bots/$botId', params: { botId: bot.id } });
        },
      },
    );
  const error = create.error && <p className="text-sm text-destructive">{create.error.message}</p>;

  if (mode.kind === 'chat') {
    return <NewChat onBack={() => setMode({ kind: 'choose' })} onDone={onDone} />;
  }

  if (mode.kind === 'template') {
    return <FromTemplate onBack={() => setMode({ kind: 'choose' })} onDone={onDone} />;
  }

  if (mode.kind === 'choose') {
    const tooFew = (bots.data?.items.length ?? 0) < GROUP_MIN;
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (name.trim()) start(false);
    };
    return (
      <>
        <DialogHeader>
          <DialogTitle>New</DialogTitle>
          <DialogDescription>
            Create a Bot step by step, or type a name and start.
          </DialogDescription>
        </DialogHeader>
        <Button
          variant="outline"
          className="justify-start"
          onClick={() => setMode({ kind: 'guided', step: 0 })}
        >
          Create new Bot
        </Button>
        <form className="flex gap-2" onSubmit={submit}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Type a name"
            aria-label="Bot name"
            maxLength={64}
            autoFocus
          />
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            Start
          </Button>
        </form>
        {error}
        <Button
          variant="outline"
          className="justify-start"
          onClick={() => setMode({ kind: 'template' })}
        >
          Create from template
        </Button>
        <Button
          variant="outline"
          className="justify-start"
          disabled={tooFew}
          onClick={() => setMode({ kind: 'chat' })}
        >
          New chat
          {tooFew && <span className="ml-auto text-xs text-muted-foreground">needs two Bots</span>}
        </Button>
      </>
    );
  }

  const { step } = mode;
  const question = step > 0 ? GUIDED_STEPS[step - 1] : undefined;
  const steps = GUIDED_STEPS.length + 2;
  const last = step === steps - 1;
  const go = (next: number) => setMode({ kind: 'guided', step: next });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (!last) return go(step + 1);
    if (!scheduled) return start(true);
    const checked = presetFromDraft(draft);
    if (!checked.ok) return setScheduleError(checked.error);
    if (!routinePrompt.trim()) return setScheduleError('Say what it should do each time');
    setScheduleError(null);
    start(true, { preset: checked.preset, prompt: routinePrompt, timezone });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>
          {last ? 'Recurring schedule' : (question?.title ?? 'Create new Bot')}
        </DialogTitle>
        <DialogDescription>
          {last
            ? 'Should it also run on a schedule? Optional.'
            : question
              ? `${question.prompt} Optional.`
              : 'What should the Bot be called?'}
        </DialogDescription>
      </DialogHeader>
      {last ? (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={scheduled}
              onChange={(event) => setScheduled(event.target.checked)}
            />
            Run on a schedule
          </label>
          {scheduled && (
            <>
              <textarea
                value={routinePrompt}
                onChange={(event) => setRoutinePrompt(event.target.value)}
                placeholder="Each time: summarize what came in overnight and flag anything urgent."
                aria-label="What to do each time"
                rows={3}
                autoFocus
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              />
              <ScheduleFields value={draft} onChange={setDraft} timezone={timezone} />
            </>
          )}
          {scheduleError && <p className="text-sm text-destructive">{scheduleError}</p>}
        </div>
      ) : question ? (
        <>
          <textarea
            key={question.key}
            value={answers[question.key] ?? ''}
            onChange={(event) => setAnswers({ ...answers, [question.key]: event.target.value })}
            placeholder={question.placeholder}
            aria-label={question.title}
            rows={3}
            autoFocus
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          />
          {question.key === 'tools' && !!connectors.data?.items.length && (
            <fieldset className="flex flex-col gap-1.5 text-sm">
              <legend className="mb-1 text-xs text-muted-foreground">Connectors it may use</legend>
              {connectors.data.items.map((connector) => (
                <label key={connector.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!off.has(connector.id)}
                    onChange={(event) => {
                      const next = new Set(off);
                      if (event.target.checked) next.delete(connector.id);
                      else next.add(connector.id);
                      setOff(next);
                    }}
                  />
                  {connector.name}
                </label>
              ))}
            </fieldset>
          )}
          {question.key === 'approval' && (
            <fieldset className="flex flex-col gap-1.5 text-sm">
              <legend className="mb-1 text-xs text-muted-foreground">
                Always ask first before using
              </legend>
              {ASK_FIRST_GROUPS.map(({ group, label }) => (
                <label key={group} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={askFirst.has(group)}
                    onChange={(event) => {
                      const next = new Set(askFirst);
                      if (event.target.checked) next.add(group);
                      else next.delete(group);
                      setAskFirst(next);
                    }}
                  />
                  {label}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">{ASKS_BY_DEFAULT}</p>
            </fieldset>
          )}
        </>
      ) : (
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name"
          aria-label="Name"
          maxLength={64}
          required
          autoFocus
        />
      )}
      {error}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{`${step + 1} of ${steps}`}</span>
        <Button
          type="button"
          variant="ghost"
          className="ml-auto"
          onClick={() => (step === 0 ? setMode({ kind: 'choose' }) : go(step - 1))}
        >
          Back
        </Button>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          {last ? 'Create' : 'Next'}
        </Button>
      </div>
    </form>
  );
}
