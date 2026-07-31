import { users } from "./schema";

/**
 * Column list for every user query that leaves the server. Selecting explicitly
 * rather than `select()` keeps password_hash out of API responses — a bare
 * `db.select().from(users)` would serialise the bcrypt hash straight to the
 * client.
 */
export const publicUserColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  createdAt: users.createdAt,
};
