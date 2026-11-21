import { boolean, check, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { apikeys, sessions, users } from './auth.js';
import { bytea, createdAt, id, timestamptz } from './columns.js';
import { workspaceId } from './workspace.js';

// Devices and pairing (docs/plans/MOBILE_AND_VM_PLAN.md section 4.1,
// docs/RELAY_PROTOCOL.md sections 2 and 6).

export const DEVICE_PLATFORMS = ['ios', 'android', 'desktop'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * Who made a pairing: a person in the app (`user`), `openbots pair` (`cli`),
 * or a signed-in browser handing a sign-in to the iOS or Mac app (`app`,
 * services/app-sign-in.ts), whose code needs the app's PKCE verifier.
 */
export const PAIRING_CREATORS = ['user', 'cli', 'app'] as const;
export type PairingCreator = (typeof PAIRING_CREATORS)[number];

/**
 * A paired client: a phone or a Mac holding an owner's API key, or a Mac app
 * signed in to the hosted service through the browser, holding a session
 * (`sessionId`) instead.
 */
export const devices = pgTable(
  'devices',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform').$type<DevicePlatform>().notNull(),
    /**
     * The device's Noise static key (X25519 public key, 32 bytes), unique
     * in its organization: one phone may pair with several organizations of
     * one server, each its own device. Cleared when the device is revoked:
     * the server forgets it (RELAY_PROTOCOL.md section 2).
     */
    publicKey: bytea('public_key'),
    /** The better-auth API key it authenticates with; null once revoked. */
    apiKeyId: uuid('api_key_id').references(() => apikeys.id, { onDelete: 'set null' }),
    /**
     * The better-auth session a Mac app signed in through the browser works
     * with (services/app-sign-in.ts), instead of an API key; null for every
     * other device. Revoking the device deletes the session, and the session
     * ending (sign-out, expiry) revokes the device.
     */
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    /** The APNs (or later FCM) token, sealed; null until `PUT /devices/{id}/push`. */
    pushToken: bytea('push_token'),
    /** `production` or `sandbox`, for the token. */
    pushEnvironment: text('push_environment'),
    /** The 32 byte ChaCha20-Poly1305 key for push payloads, sealed; null once revoked. */
    pushKey: bytea('push_key'),
    lastSeenAt: timestamptz('last_seen_at'),
    createdAt: createdAt(),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [
    index('devices_workspace_owner').on(t.workspaceId, t.ownerId),
    unique('devices_workspace_public_key').on(t.workspaceId, t.publicKey),
    unique('devices_session_id').on(t.sessionId),
  ],
);

/** A pairing offer: the link's code, good for 5 minutes and once. */
export const devicePairings = pgTable(
  'device_pairings',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** Null when the install has no owner yet; the pairing then makes one (`createsOwner`). */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the link's 32 byte code. */
    codeHash: bytea('code_hash').notNull().unique(),
    directUrls: text('direct_urls')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The server's name in the link. */
    name: text('name').notNull(),
    createsOwner: boolean('creates_owner').notNull().default(false),
    /**
     * An app sign-in's PKCE challenge (base64url SHA-256 of the app's
     * verifier, RFC 7636 S256): the code works only with the verifier, so
     * another app that catches the `openbots://` redirect cannot use it.
     * Null for a QR pairing.
     */
    codeChallenge: text('code_challenge'),
    /**
     * The app an app sign-in's code is for: `ios` trades it at
     * `POST /devices/pair`, `desktop` at `POST /app-sign-in/session`, and
     * neither at the other's route. Null for a QR pairing.
     */
    appPlatform: text('app_platform').$type<'ios' | 'desktop'>(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    createdBy: text('created_by').$type<PairingCreator>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('device_pairings_workspace_owner').on(t.workspaceId, t.ownerId)],
);

/**
 * The install's relay identity: one Ed25519 key pair, made at first start
 * and sealed with the master key. Not an organization's, so no workspace_id.
 * The single row has id 1.
 */
export const instanceKeys = pgTable(
  'instance_keys',
  {
    id: integer('id').primaryKey().default(1),
    signingKey: bytea('signing_key').notNull(),
    publicKey: bytea('public_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [check('instance_keys_one_row', sql`${t.id} = 1`)],
);
