import { unwrap, type components } from '@openbot/api-client';
import { Button, Input } from '@openbot/ui';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { api, meQuery } from '../../app/api.js';

// Admin controls (U3): signup mode, public template links, limits and how
// long the audit log keeps its rows, on the managed service. A self-hosted
// install has one owner and only the limits (`LimitsSettings`); the rest
// keep their defaults there.

type Settings = components['schemas']['Settings'];
type SignupMode = Settings['signupMode'];
type Limits = Settings['limits'];

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => unwrap(api.GET('/api/v1/settings')),
});

export const SIGNUP_MODES: { value: SignupMode; label: string }[] = [
  { value: 'first_user_admin', label: 'First user admin, then invites' },
  { value: 'invite', label: 'Invite only' },
  { value: 'open', label: 'Open' },
];

export const LIMIT_LABELS: Record<keyof Limits, string> = {
  botsPerAccount: 'Bots per account',
  botsPerGroup: 'Bots per group',
  routinesPerBot: 'Routines per Bot',
  skillsPerAccount: 'Skills per account',
  runRecordsPerRoutine: 'Run records per Routine',
  webhookPayloadBytes: 'Webhook payload (bytes)',
  syncWebhookWaitSeconds: 'Sync webhook wait (seconds)',
  webhookIpRatePerMin: 'Webhook requests per address (a minute)',
  webhookFailedAuthPerMin: 'Failed webhook checks per address (a minute)',
  webhookEndpointRatePerMin: 'Webhook endpoint default rate (a minute)',
  uploadBytes: 'Upload size (bytes)',
};

/**
 * The limits a submitted form changes. Only limits that differ from the
 * current ones are sent, so untouched limits keep following the env.
 */
export function limitsPatch(form: FormData, current: Limits): Partial<Limits> {
  const limits: Partial<Limits> = {};
  for (const key of Object.keys(LIMIT_LABELS) as (keyof Limits)[]) {
    const value = Number(form.get(key));
    if (value !== current[key]) limits[key] = value;
  }
  return limits;
}

/** The PATCH body for the managed service's Admin settings form. */
export function settingsPatch(form: FormData, current: Limits) {
  return {
    signupMode: form.get('signupMode') as SignupMode,
    publicTemplatesEnabled: form.get('publicTemplatesEnabled') === 'on',
    limits: limitsPatch(form, current),
    auditRetentionDays: Number(form.get('auditRetentionDays')),
  };
}

type SettingsPatch = components['schemas']['SettingsPatch'];

function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsPatch) => unwrap(api.PATCH('/api/v1/settings', { body })),
    onSuccess: (settings) => {
      queryClient.setQueryData(settingsQuery.queryKey, settings);
      return queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
  });
}

function LimitFields({ limits }: { limits: Limits }) {
  return (
    <fieldset className="grid grid-cols-2 gap-4">
      <legend className="mb-2 text-sm font-medium">Limits</legend>
      {(Object.keys(LIMIT_LABELS) as (keyof Limits)[]).map((key) => (
        <label key={key} className="flex flex-col gap-1.5 text-sm">
          {LIMIT_LABELS[key]}
          <Input name={key} type="number" min={1} step={1} defaultValue={limits[key]} required />
        </label>
      ))}
    </fieldset>
  );
}

function SaveRow({ save }: { save: ReturnType<typeof useSaveSettings> }) {
  return (
    <>
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-sm text-muted-foreground">Saved</span>}
      </div>
    </>
  );
}

/** A self-hosted owner's limits: how many Bots, Routines and Skills, and upload and webhook caps. */
export function LimitsSettings() {
  const { data } = useQuery(settingsQuery);
  const save = useSaveSettings();
  if (!data) return null;
  const current = data.limits;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate({ limits: limitsPatch(new FormData(event.currentTarget), current) });
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <LimitFields limits={current} />
      <SaveRow save={save} />
    </form>
  );
}

export function AdminSettings() {
  const { data } = useQuery(settingsQuery);
  const save = useSaveSettings();
  if (!data) return null;
  const current = data.limits;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(settingsPatch(new FormData(event.currentTarget), current));
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Signup mode
        <select
          name="signupMode"
          defaultValue={data.signupMode}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {SIGNUP_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="publicTemplatesEnabled"
          defaultChecked={data.publicTemplatesEnabled}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">Public template links</span>
          <span className="text-muted-foreground">
            Lets members share templates with anyone who has the link.
          </span>
        </span>
      </label>
      <LimitFields limits={data.limits} />
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Keep the audit log for (days)</span>
        <Input
          name="auditRetentionDays"
          type="number"
          min={1}
          max={3650}
          step={1}
          defaultValue={data.auditRetentionDays}
          required
          className="w-40"
        />
      </label>
      <SaveRow save={save} />
    </form>
  );
}
