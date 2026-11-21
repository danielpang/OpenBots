import { unwrap } from '@openbots/api-client';
import { Button, Input } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { billingQuery, orgApi, type Billing, type BillingPlanId, type MemberUsage } from './api.js';

// Settings > Billing (plan 21.10): the plan, its seats and what the next
// invoice comes to; this period's computer hours against the allowance, with
// who used them; and the limits. Owners and admins choose a plan, the
// overage policy and the spending limit, and cap members; everyone sets a
// limit for themselves, never above their cap. The server checks every rule
// again: what is hidden here is not a permission.

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
const usd = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
const hoursText = (n: number) => `${n} ${n === 1 ? 'hour' : 'hours'}`;

/** Why new work is stopped, in the words the Billing tab uses. */
export function stoppedText(billing: Billing): string | null {
  const resumes = day(billing.period.end);
  switch (billing.usage.stopped) {
    case 'none':
      return 'This organization has no plan, so new computer work cannot start. Start a trial below.';
    case 'inactive':
      return 'The subscription is unpaid or cancelled, so new computer work is paused. Update the payment details to go on; nothing has been deleted.';
    case 'trial':
      return 'The trial’s computer hours are used. Start the paid plan to keep working.';
    case 'allowance':
      return `The plan’s computer hours are used, and new work is stopped until ${resumes}. Allowing overage starts it again.`;
    case 'ceiling':
      return `Overage reached the spending limit, and new work is stopped until ${resumes}. Raising the limit starts it again.`;
    default:
      return null;
  }
}

export function BillingSettings() {
  const { data, error } = useQuery(billingQuery);
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!data) return null;
  return <BillingView billing={data} />;
}

export function BillingView({ billing }: { billing: Billing }) {
  const stopped = stoppedText(billing);
  return (
    <div className="flex flex-col gap-10">
      {stopped && (
        <p role="status" className="rounded-md border border-destructive/40 p-3 text-sm">
          {stopped}
        </p>
      )}
      <PlanSection billing={billing} />
      <UsageSection billing={billing} />
      {billing.canManage && <SpendingSection billing={billing} />}
      {billing.canManage && <MembersSection billing={billing} />}
      <PersonalLimit me={billing.me} />
    </div>
  );
}

function useBillingMutation<T>(fn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: billingQuery.queryKey }),
  });
}

function PlanSection({ billing }: { billing: Billing }) {
  const [policy, setPolicy] = useState<'stop' | 'allow'>(billing.overage.policy);
  const checkout = useBillingMutation(async (plan: BillingPlanId) => {
    const result = await unwrap(
      orgApi.POST('/api/v1/billing/checkout', { body: { plan, overagePolicy: policy } }),
    );
    if (result.url) window.location.assign(result.url);
  });
  const portal = useMutation({
    mutationFn: () => unwrap(orgApi.POST('/api/v1/billing/portal')),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const { plan, seats } = billing;
  const live = plan.kind === 'trial' || plan.kind === 'paid';
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Plan</h2>
      <p className="text-sm">
        {plan.name}
        {plan.kind === 'trial' && plan.trialEndsAt && `, until ${day(plan.trialEndsAt)}`}
        {seats.monthlyTotalUsd !== null &&
          `. ${seats.billed ?? seats.active} ${(seats.billed ?? seats.active) === 1 ? 'seat' : 'seats'} at ${usd(seats.perSeatUsd ?? 0)}: ${usd(seats.monthlyTotalUsd)} a month before overage.`}
      </p>
      {billing.canManage && billing.stripe && (
        <div className="flex flex-col gap-3">
          {(!live || plan.kind === 'trial') && (
            <label className="flex flex-col gap-1.5 text-sm">
              When the hours run out
              <select
                aria-label="When the hours run out"
                value={policy}
                onChange={(e) => setPolicy(e.currentTarget.value as 'stop' | 'allow')}
                className="h-9 w-fit rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="stop">Stop new work</option>
                <option value="allow">
                  Keep working at {usd(billing.overage.usdPerHour)} a computer hour
                </option>
              </select>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {billing.catalog
              .filter((p) => !(plan.kind === 'paid' && plan.id === p.id))
              .map((p) => (
                <Button
                  key={p.id}
                  variant={live ? 'outline' : 'default'}
                  disabled={checkout.isPending}
                  onClick={() => checkout.mutate(p.id)}
                >
                  {buttonLabel(billing, p.id, p.name)}
                </Button>
              ))}
            {live && (
              <Button variant="ghost" disabled={portal.isPending} onClick={() => portal.mutate()}>
                Manage payment and invoices
              </Button>
            )}
          </div>
          <ul className="text-sm text-muted-foreground">
            {billing.catalog.map((p) => (
              <li key={p.id}>
                {p.name}: {usd(p.perSeatUsd)} a seat a month
                {p.minimumSeats > 1 ? `, ${p.minimumSeats} seats at least` : ''}, {p.hoursPerSeat}{' '}
                computer hours a seat. {p.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
      {checkout.error && <p className="text-sm text-destructive">{checkout.error.message}</p>}
      {portal.error && <p className="text-sm text-destructive">{portal.error.message}</p>}
    </section>
  );
}

function buttonLabel(billing: Billing, id: BillingPlanId, name: string) {
  if (billing.plan.kind === 'trial') {
    return billing.plan.id === id ? `Start ${name} now` : `Start ${name} now instead`;
  }
  if (billing.plan.kind === 'paid') return `Change to ${name}`;
  return billing.trial.available
    ? `Try ${name} free for ${billing.trial.days} days`
    : `Choose ${name}`;
}

function UsageSection({ billing }: { billing: Billing }) {
  const { usage, overage, period } = billing;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">This period</h2>
      <p className="text-sm">
        {usage.usedHours} of {hoursText(usage.allowanceHours)} used, until {day(period.end)}.
        {usage.overageHours > 0 &&
          (overage.policy === 'allow'
            ? ` Overage so far: ${hoursText(usage.overageHours)}, ${usd(usage.overageUsd)}.`
            : ` ${hoursText(usage.overageHours)} past the allowance, from work that was already running.`)}
      </p>
      <p className="text-sm text-muted-foreground">
        A computer hour is an hour a member’s computer was awake for their work.
      </p>
    </section>
  );
}

function SpendingSection({ billing }: { billing: Billing }) {
  const save = useBillingMutation(
    (body: { overagePolicy?: 'stop' | 'allow'; ceilingUsd?: number | null }) =>
      unwrap(orgApi.PATCH('/api/v1/billing/settings', { body })),
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ceiling = String(form.get('ceilingUsd') ?? '').trim();
    save.mutate({
      overagePolicy: form.get('overagePolicy') as 'stop' | 'allow',
      ceilingUsd: ceiling === '' ? null : Number(ceiling),
    });
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Spending</h2>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <label className="flex flex-col gap-1.5 text-sm">
          Past the allowance
          <select
            name="overagePolicy"
            defaultValue={billing.overage.policy}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="stop">Stop new work</option>
            <option value="allow">Keep working at {usd(billing.overage.usdPerHour)} an hour</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Spending limit on overage ($)
          <Input
            name="ceilingUsd"
            type="number"
            min={0}
            step={0.01}
            className="w-40"
            defaultValue={billing.overage.ceilingIsDefault ? '' : billing.overage.ceilingUsd}
            placeholder={String(billing.overage.ceilingUsd)}
          />
        </label>
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Left empty, the limit is the monthly seat total ({usd(billing.overage.ceilingUsd)} now). New
        work stops there; work already running finishes.
      </p>
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
    </section>
  );
}

function MembersSection({ billing }: { billing: Billing }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Members</h2>
      <ul className="flex flex-col divide-y rounded-md border">
        {billing.members.map((member) => (
          <MemberCapRow key={member.userId} member={member} />
        ))}
      </ul>
    </section>
  );
}

export function MemberCapRow({ member }: { member: MemberUsage }) {
  const save = useBillingMutation((capHours: number | null) =>
    unwrap(
      orgApi.PUT('/api/v1/billing/members/{id}/cap', {
        params: { path: { id: member.userId } },
        body: { capHours },
      }),
    ),
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('cap') ?? '').trim();
    save.mutate(value === '' ? null : Number(value));
  }
  return (
    <li className="flex flex-wrap items-center gap-3 p-3 text-sm" data-usage={member.userId}>
      <span className="min-w-0 flex-1 truncate">{member.name ?? 'Former member'}</span>
      <span className="text-muted-foreground">{hoursText(member.usedHours)} used</span>
      <form className="flex items-center gap-2" onSubmit={submit}>
        <Input
          name="cap"
          type="number"
          min={0}
          step={0.1}
          className="w-28"
          aria-label={`Cap for ${member.name ?? 'this member'} (hours)`}
          placeholder="No cap"
          defaultValue={member.capHours ?? ''}
        />
        <Button type="submit" size="sm" variant="outline" disabled={save.isPending}>
          Set cap
        </Button>
      </form>
      {save.error && <p className="w-full text-destructive">{save.error.message}</p>}
    </li>
  );
}

function PersonalLimit({ me }: { me: MemberUsage }) {
  const save = useBillingMutation((personalHours: number | null) =>
    unwrap(orgApi.PUT('/api/v1/billing/limit', { body: { personalHours } })),
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('personal') ?? '').trim();
    save.mutate(value === '' ? null : Number(value));
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Your limit</h2>
      <p className="text-sm">
        You have used {hoursText(me.usedHours)} this period.
        {me.capHours !== null && ` An admin capped you at ${hoursText(me.capHours)}.`}
      </p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <label className="flex flex-col gap-1.5 text-sm">
          Stop my new work after (hours)
          <Input
            name="personal"
            type="number"
            min={0}
            step={0.1}
            className="w-40"
            placeholder="No limit"
            defaultValue={me.personalHours ?? ''}
            {...(me.capHours !== null ? { max: me.capHours } : {})}
          />
        </label>
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
      </form>
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
    </section>
  );
}
