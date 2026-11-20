import { unwrap, type components } from '@openbots/api-client';
import { Button, Input, SaveButton, Switch, useSaveState } from '@openbots/ui';
import { SettingsPanel } from '../../app/settings-layout.js';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, capabilitiesQuery, meQuery } from '../../app/api.js';
import { useLocalAuth } from '../../app/deployment.js';

// The limits (U3): a self-hosted owner's in Settings > Limits, with public
// links to Artifacts (plan 21.11). On the managed service each
// organization's owners and admins change them, with the audit log's
// retention, in the settings the managed build adds (plan 21.5), which
// reuses the pieces below.

type Settings = components['schemas']['Settings'];
type Limits = Settings['limits'];

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => unwrap(api.GET('/api/v1/settings')),
});

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

/** In the Mac app's local mode there are no accounts to count per. */
const LOCAL_LIMIT_LABELS: Partial<Record<keyof Limits, string>> = {
  botsPerAccount: 'Bots',
  skillsPerAccount: 'Skills',
};

export function limitLabel(key: keyof Limits, localAuth: boolean): string {
  return (localAuth && LOCAL_LIMIT_LABELS[key]) || LIMIT_LABELS[key];
}

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

type SettingsPatch = components['schemas']['SettingsPatch'];

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsPatch) => unwrap(api.PATCH('/api/v1/settings', { body })),
    onSuccess: (settings) => {
      queryClient.setQueryData(settingsQuery.queryKey, settings);
      return queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
  });
}

/** The limit inputs; `ceilings` caps each (the managed service's, plan 21.6). */
export function LimitFields({ limits, ceilings }: { limits: Limits; ceilings?: Limits | null }) {
  const localAuth = useLocalAuth();
  return (
    <fieldset className="flex min-w-0 flex-col">
      <legend className="mb-3 text-base font-semibold">Limits</legend>
      <SettingsPanel>
        {(Object.keys(LIMIT_LABELS) as (keyof Limits)[]).map((key) => (
          <label
            key={key}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5"
          >
            <span className="min-w-0 flex-1 text-foreground">{limitLabel(key, localAuth)}</span>
            <Input
              name={key}
              type="number"
              min={1}
              max={ceilings?.[key]}
              step={1}
              defaultValue={limits[key]}
              required
              className="h-8 w-28 tabular-nums"
            />
          </label>
        ))}
      </SettingsPanel>
    </fieldset>
  );
}

export function SaveRow({ save }: { save: ReturnType<typeof useSaveSettings> }) {
  const saved = useSaveState(save);
  return (
    <>
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      <div className="flex items-center gap-3">
        <SaveButton type="submit" state={saved.state}>
          Save
        </SaveButton>
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
    <div className="flex flex-col gap-10">
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <LimitFields limits={current} />
        <SaveRow save={save} />
      </form>
      <PublicLinksSetting />
    </div>
  );
}

/** How many links turning public links off stops, said before it is done. */
export function stopLinksText(count: number): string {
  if (count === 0) return 'No Artifact is public now.';
  const links = count === 1 ? '1 public link stops' : `${count} public links stop`;
  return `${links} working. Each of those Artifacts stays visible to your organization, and its owner has to make it public again one by one.`;
}

/**
 * Public links to Artifacts, for the whole organization (plan 21.11): off
 * until an owner or admin turns them on. Turning them off makes every public
 * Artifact visible to the organization only, so it asks first and says how
 * many links stop. Only when the server hosts Artifacts.
 */
export function PublicLinksSetting() {
  const capabilities = useQuery(capabilitiesQuery);
  const { data } = useQuery(settingsQuery);
  const save = useSaveSettings();
  const [confirming, setConfirming] = useState(false);
  if (!capabilities.data?.artifactSharing || !data) return null;
  // While a change is saving, show the value asked for, not the one before it.
  const asked = save.isPending ? save.variables?.publicArtifactsEnabled : undefined;
  const checked = asked ?? data.publicArtifactsEnabled;
  const turnOff = () => {
    setConfirming(false);
    save.mutate({ publicArtifactsEnabled: false });
  };
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Sharing</h2>
      <label className="flex items-start gap-3 text-sm">
        <Switch
          name="publicArtifactsEnabled"
          checked={checked}
          disabled={save.isPending || confirming}
          onChange={(event) => {
            if (event.target.checked) save.mutate({ publicArtifactsEnabled: true });
            else if (data.publicArtifacts > 0) setConfirming(true);
            else turnOff();
          }}
        />
        <span className="flex flex-col gap-1">
          <span className="font-medium">Allow public links</span>
          <span className="text-muted-foreground">
            Off by default. When on, members can make an Artifact public, so anyone with its link
            can view it without signing in. Turning this off makes every public Artifact visible to
            your organization only.
          </span>
        </span>
      </label>
      {confirming && (
        <div className="flex flex-col gap-2 rounded border p-3 text-sm" role="alertdialog">
          <p>Turn off public links? {stopLinksText(data.publicArtifacts)}</p>
          <div className="flex gap-2">
            <Button variant="destructive" onClick={turnOff}>
              Turn off public links
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
    </section>
  );
}
