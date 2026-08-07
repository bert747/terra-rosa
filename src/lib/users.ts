// Client-safe user helpers: no database imports, so client components can
// share these constants instead of duplicating them. Column lists that need
// the Drizzle schema live in src/db/users.ts.

export const MIN_PASSWORD_LENGTH = 8;

export const ROLES = ["editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export function isValidRole(role: unknown): role is Role {
  return typeof role === "string" && (ROLES as readonly string[]).includes(role);
}

// Excludes visually-confusable characters (0/O, 1/I/l) — this is read off a
// screen and typed back in by hand at least once, on someone else's device.
const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/**
 * A random server-generated temporary password — see POST
 * /api/users/[id]/reset-password. Only ever called server-side (uses
 * globalThis.crypto, available in both Node and Edge runtimes) but lives in
 * this client-safe module so its length constant can sit next to
 * MIN_PASSWORD_LENGTH rather than duplicated.
 */
export function generateTempPassword(length = 12): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length]).join("");
}

/** users_email_idx is a unique index; Drizzle wraps the driver error, so check `cause` too. */
export function isDuplicateEmail(err: unknown): boolean {
  const code =
    (err as { code?: string })?.code ?? ((err as { cause?: { code?: string } })?.cause)?.code;
  return code === "23505";
}
