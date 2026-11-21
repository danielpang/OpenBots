import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { CLIENT_IP_HEADER, clientIp, rateLimitKey } from '../client-ip.js';
import type { AppEnv } from '../context.js';
import { DomainError } from '../errors.js';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  APP_SIGN_IN_PLATFORMS,
  completeAppSession,
  createAppSignInCode,
} from '../services/app-sign-in.js';
import { PAIRING_CODE_BYTES, fromBase64url, pairingCodeHash } from '../services/devices.js';
import { PAIR_CLIENT_LIMIT, PAIR_CODE_LIMIT } from './devices.js';

// App sign-in through the browser (services/app-sign-in.ts). The code route
// is for a signed-in browser; the session route is the Mac app's, with no
// sign-in: the code and its verifier are the credential, rate-limited like
// `POST /devices/pair` per client and per code.

const CodeRequestSchema = z
  .strictObject({
    platform: z.enum(APP_SIGN_IN_PLATFORMS).openapi({ description: 'The app being signed in' }),
    codeChallenge: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .openapi({ description: "The app's PKCE challenge: base64url SHA-256 of its verifier" }),
  })
  .openapi('AppSignInCodeRequest');

const CodeSchema = z
  .object({
    code: z.string().openapi({ description: 'The one-time code, base64url; shown only once' }),
    expiresAt: z.iso.datetime(),
  })
  .openapi('AppSignInCode');

const SessionRequestSchema = z
  .strictObject({
    code: z.string().min(1).max(256),
    codeVerifier: z
      .string()
      .regex(/^[A-Za-z0-9._~-]{43,128}$/)
      .openapi({ description: 'The PKCE verifier the challenge was made from' }),
    name: z.string().trim().min(1).max(100).openapi({ description: "This Mac's name in Devices" }),
  })
  .openapi('AppSessionRequest');

const AppSessionSchema = z
  .object({
    device: z.object({
      id: z.uuid(),
      name: z.string(),
      platform: z.literal('desktop'),
      createdAt: z.iso.datetime(),
    }),
    user: z.object({ id: z.uuid(), name: z.string() }),
  })
  .openapi('AppSession');

const rateLimited = (c: Context<AppEnv>, retryAfter: number | null, fallback: number) => {
  c.header('retry-after', String(retryAfter ?? fallback));
  return new DomainError(429, 'RATE_LIMITED', 'Too many sign-in attempts; try again later');
};

export const appSignInRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'post',
      path: '/app-sign-in/codes',
      tags: ['devices'],
      summary: 'Make a one-time code that signs the iOS or Mac app in (a browser session only)',
      description:
        'The web app calls this at /app-sign-in once the person confirms, then sends the browser to `openbots://app-sign-in#code=...&state=...`. The code lasts 5 minutes, works once, and only with the verifier of `codeChallenge`. API keys answer 403 SESSION_REQUIRED.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: CodeRequestSchema } } },
      },
      responses: {
        201: {
          description: 'The code',
          content: { 'application/json': { schema: CodeSchema } },
        },
        400: problemResponse('Invalid request'),
        409: problemResponse('Too many open codes and pairings (TOO_MANY_PAIRINGS)'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { db, config } = c.var.deps;
      const body = c.req.valid('json');
      const result = await createAppSignInCode({
        db,
        config,
        user: c.var.user,
        platform: body.platform,
        codeChallenge: body.codeChallenge,
      });
      return c.json(result, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/app-sign-in/session',
      tags: ['devices'],
      summary: 'Trade an app sign-in code for a session (the Mac app)',
      description:
        'No authentication: the code and its PKCE verifier are the credential. Rate-limited per client (10 an hour) and per code (5 tries). Sets the session cookie and makes the Mac a device, which Settings > Devices can revoke. The iOS app trades its code at `POST /devices/pair` instead, with `codeVerifier`.',
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: SessionRequestSchema } },
        },
      },
      responses: {
        200: {
          description: 'The device and its owner, with the session cookie set',
          content: { 'application/json': { schema: AppSessionSchema } },
        },
        400: problemResponse('Invalid request'),
        401: problemResponse(
          'The code is unknown, used, expired, not a Mac app sign-in code, or the verifier is wrong (PAIRING_INVALID)',
        ),
        403: problemResponse('This server signs in from the Mac app only (LOCAL_ONLY)'),
        429: problemResponse('Too many attempts'),
      },
    }),
    async (c) => {
      const { db, auth, config, infra } = c.var.deps;
      const body = c.req.valid('json');
      const client = await infra.limiter.consume(
        `app-session:${rateLimitKey(c) ?? 'unknown'}`,
        PAIR_CLIENT_LIMIT,
      );
      if (!client.allowed) throw rateLimited(c, client.retryAfter, PAIR_CLIENT_LIMIT.window);
      const code = fromBase64url(body.code, PAIRING_CODE_BYTES);
      if (code) {
        const tries = await infra.limiter.consume(
          `pair-code:${pairingCodeHash(code).toString('hex')}`,
          PAIR_CODE_LIMIT,
        );
        if (!tries.allowed) throw rateLimited(c, tries.retryAfter, PAIR_CODE_LIMIT.window);
      }
      const headers = new Headers();
      const ip = clientIp(c);
      if (ip) headers.set(CLIENT_IP_HEADER, ip);
      const userAgent = c.req.header('user-agent');
      if (userAgent) headers.set('user-agent', userAgent.slice(0, 512));
      const result = await completeAppSession({ db, auth, config, infra, body, headers });
      for (const cookie of result.cookies) c.header('set-cookie', cookie, { append: true });
      return c.json({ device: result.device, user: result.user }, 200);
    },
  );
