// Client-safe user helpers: no database imports, so client components can
// share these constants instead of duplicating them. Column lists that need
// the Drizzle schema live in src/db/users.ts.

export const MIN_PASSWORD_LENGTH = 8;

export const ROLES = ["editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export function isValidRole(role: unknown): role is Role {
  return typeof role === "string" && (ROLES as readonly string[]).includes(role);
}

/** users_email_idx is a unique index; Drizzle wraps the driver error, so check `cause` too. */
export function isDuplicateEmail(err: unknown): boolean {
  const code =
    (err as { code?: string })?.code ?? ((err as { cause?: { code?: string } })?.cause)?.code;
  return code === "23505";
}
