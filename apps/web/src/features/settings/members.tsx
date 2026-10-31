import { unwrap, type components } from '@openbot/api-client';
import { Button, Input } from '@openbot/ui';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, meQuery } from '../../app/api.js';

// Users and invites (U1, U3, plan 14.1), in the admin section of Settings:
// invite someone (the link is shown once, with Copy), the pending invites
// with Revoke, and the members with their role and whether they can sign in.
// Disabling ends a member's sessions and stops their API keys; their Bots
// and data stay. The server keeps one admin who can sign in.

type Member = components['schemas']['Member'];
type Role = components['schemas']['Role'];

export const membersQuery = queryOptions({
  queryKey: ['admin', 'members'],
  queryFn: () => unwrap(api.GET('/api/v1/admin/members')),
});

export const invitesQuery = queryOptions({
  queryKey: ['admin', 'invites'],
  queryFn: () => unwrap(api.GET('/api/v1/admin/invites')),
});

/** The link that signs someone up with an invite token (the sign-up page reads `?invite=`). */
export function inviteLink(token: string, origin: string): string {
  const url = new URL('/sign-up', origin);
  url.searchParams.set('invite', token);
  return url.toString();
}

/** How long an invite link works. */
export const INVITE_DAYS = 7;

/** The POST body for a submitted invite form: the email only when one is given. */
export function invitePayload(form: FormData): {
  email?: string;
  role: Role;
  expiresInDays: number;
} {
  const email = String(form.get('email') ?? '').trim();
  return {
    ...(email ? { email } : {}),
    role: form.get('role') === 'admin' ? 'admin' : 'member',
    expiresInDays: INVITE_DAYS,
  };
}

const day = (iso: string) => new Date(iso).toLocaleDateString();

export function MembersSettings() {
  return (
    <div className="flex flex-col gap-8">
      <InviteForm />
      <PendingInvites />
      <Members />
    </div>
  );
}

function InviteForm() {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: (body: ReturnType<typeof invitePayload>) =>
      unwrap(api.POST('/api/v1/admin/invites', { body })),
    onSuccess: () => {
      setCopied(false);
      return queryClient.invalidateQueries({ queryKey: invitesQuery.queryKey });
    },
  });
  const link = create.data ? inviteLink(create.data.token, window.location.origin) : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    create.mutate(invitePayload(new FormData(form)), { onSuccess: () => form.reset() });
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard access: the field is selectable.
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Invite someone</h2>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-sm">
          Email (optional)
          <Input
            name="email"
            type="email"
            placeholder="Anyone with the link"
            aria-label="Invite email"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Role
          <select
            name="role"
            defaultValue="member"
            aria-label="Invite role"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <Button type="submit" disabled={create.isPending}>
          Create invite link
        </Button>
      </form>
      {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
      {link && (
        <div className="flex flex-col gap-1.5 rounded-md border p-3 text-sm">
          <p>Copy this link now. It is shown only once and works for {INVITE_DAYS} days.</p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={link}
              aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" variant="outline" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function PendingInvites() {
  const queryClient = useQueryClient();
  const { data } = useQuery(invitesQuery);
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/v1/admin/invites/{id}', { params: { path: { id } } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: invitesQuery.queryKey }),
  });

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Pending invites</h2>
      {revoke.error && <p className="text-sm text-destructive">{revoke.error.message}</p>}
      <ul className="divide-y rounded-md border" aria-label="Pending invites">
        {data?.items.map((invite) => (
          <li key={invite.id} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
            <span className="flex flex-col">
              <span>{invite.email ?? 'Anyone with the link'}</span>
              <span className="text-muted-foreground">
                {invite.role === 'admin' ? 'Admin' : 'Member'}, expires {day(invite.expiresAt)}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(invite.id)}
            >
              Revoke
            </Button>
          </li>
        ))}
        {data && !data.items.length && (
          <li className="px-3 py-2 text-sm text-muted-foreground">No pending invites.</li>
        )}
      </ul>
    </section>
  );
}

function Members() {
  const queryClient = useQueryClient();
  const { data } = useQuery(membersQuery);
  const me = useQuery(meQuery);
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: Role; disabled?: boolean }) =>
      unwrap(api.PATCH('/api/v1/admin/members/{id}', { params: { path: { id } }, body })),
    onSuccess: (member) =>
      queryClient.setQueryData(membersQuery.queryKey, (current) =>
        current ? { items: current.items.map((m) => (m.id === member.id ? member : m)) } : current,
      ),
    // The caller's own role may have changed.
    onSettled: () => queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
  });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">Members</h2>
        <p className="text-sm text-muted-foreground">
          Disabling signs them out and stops their API keys; their data stays.
        </p>
      </div>
      {update.error && <p className="text-sm text-destructive">{update.error.message}</p>}
      <ul className="divide-y rounded-md border" aria-label="Members">
        {data?.items.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            self={member.id === me.data?.user.id}
            pending={update.isPending}
            onChange={(change) => update.mutate({ id: member.id, ...change })}
          />
        ))}
      </ul>
    </section>
  );
}

function MemberRow({
  member,
  self,
  pending,
  onChange,
}: {
  member: Member;
  self: boolean;
  pending: boolean;
  onChange(change: { role?: Role; disabled?: boolean }): void;
}) {
  const disabled = member.disabledAt !== null;
  const bots = `${member.botCount} ${member.botCount === 1 ? 'Bot' : 'Bots'}`;
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm"
      data-member={member.email}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">
          {member.name}
          {self && <span className="text-muted-foreground"> (you)</span>}
          {disabled && <span className="ml-2 text-destructive">Disabled</span>}
        </span>
        <span className="truncate text-muted-foreground">
          {member.email}, {bots}, joined {day(member.createdAt)}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <select
          aria-label={`Role of ${member.email}`}
          value={member.role}
          disabled={pending}
          onChange={(e) => onChange({ role: e.currentTarget.value as Role })}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        {!self && (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onChange({ disabled: !disabled })}
          >
            {disabled ? 'Enable' : 'Disable'}
          </Button>
        )}
      </span>
    </li>
  );
}
