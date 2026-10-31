// Invite email through Resend (plan 21.5), when RESEND_API_KEY and
// OPENBOT_EMAIL_FROM are set. Without them an invitation is still made and
// the inviter copies its link; a failed send is logged and the link stays.

export interface EmailOptions {
  /** RESEND_API_KEY. */
  apiKey?: string;
  /** OPENBOT_EMAIL_FROM, such as `OpenBots <hi@example.com>`. */
  from?: string;
  /** The HTTP client; tests stand in a fake. */
  fetch?: typeof fetch;
}

export interface InviteEmail {
  to: string;
  organization: string;
  inviter: string;
  role: string;
  link: string;
}

export const RESEND_URL = 'https://api.resend.com/emails';

export function emailEnabled(options: EmailOptions): boolean {
  return Boolean(options.apiKey && options.from);
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/** The message; plain words, no dashes (the copy rule). */
export function inviteMessage(invite: InviteEmail) {
  const subject = `Join ${invite.organization} on OpenBots`;
  const intro = `${invite.inviter} invited you to ${invite.organization} on OpenBots as ${
    invite.role === 'member' ? 'a member' : `an ${invite.role}`
  }.`;
  const text = `${intro}\n\nAccept the invite: ${invite.link}\n\nThe link works for 7 days.\n`;
  const html = `<p>${escape(intro)}</p><p><a href="${escape(invite.link)}">Accept the invite</a></p><p>The link works for 7 days.</p>`;
  return { subject, text, html };
}

/** Sends the invite; true when Resend took it. Never throws. */
export async function sendInviteEmail(
  options: EmailOptions,
  invite: InviteEmail,
  log: (error: unknown) => void = () => {},
): Promise<boolean> {
  if (!emailEnabled(options)) return false;
  const { subject, text, html } = inviteMessage(invite);
  try {
    const res = await (options.fetch ?? fetch)(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: options.from, to: [invite.to], subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
    return true;
  } catch (error) {
    log(error);
    return false;
  }
}
