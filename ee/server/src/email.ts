// Email through Resend (plan 21.5), when RESEND_API_KEY and
// OPENBOT_EMAIL_FROM are set: invitations and email verification. Without
// them an invitation is still made and the inviter copies its link. Links
// in these emails are credentials: a failed send logs who and why, never
// the link or its token, and only a development server that sends no email
// may log verification links (OPENBOT_DEV_LOG_EMAIL_LINKS).

export interface EmailOptions {
  /** RESEND_API_KEY. */
  apiKey?: string;
  /** OPENBOT_EMAIL_FROM, such as `OpenBots <hi@example.com>`. */
  from?: string;
  /** The HTTP client; tests stand in a fake. */
  fetch?: typeof fetch;
  /**
   * OPENBOT_DEV_LOG_EMAIL_LINKS: with no email set up, log verification
   * links so a developer can open them. Refused with NODE_ENV=production.
   */
  logLinks?: boolean;
}

/** An error's message alone: a request error could carry what was sent. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
export function sendInviteEmail(
  options: EmailOptions,
  invite: InviteEmail,
  log: (error: unknown) => void = () => {},
): Promise<boolean> {
  return send(options, invite.to, inviteMessage(invite), log);
}

export function verificationMessage(link: string) {
  const subject = 'Verify your email for OpenBots';
  const text = `Open this link to verify your email and sign in:\n\n${link}\n\nThe link works for 24 hours.\n`;
  const html = `<p>Open this link to verify your email and sign in.</p><p><a href="${escape(link)}">Verify my email</a></p><p>The link works for 24 hours.</p>`;
  return { subject, text, html };
}

/** Sends the email verification link; true when Resend took it. Never throws. */
export function sendVerificationEmail(
  options: EmailOptions,
  { to, link }: { to: string; link: string },
  log: (error: unknown) => void = () => {},
): Promise<boolean> {
  return send(options, to, verificationMessage(link), log);
}

async function send(
  options: EmailOptions,
  to: string,
  { subject, text, html }: { subject: string; text: string; html: string },
  log: (error: unknown) => void,
): Promise<boolean> {
  if (!emailEnabled(options)) return false;
  try {
    const res = await (options.fetch ?? fetch)(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: options.from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
    return true;
  } catch (error) {
    log(error);
    return false;
  }
}
