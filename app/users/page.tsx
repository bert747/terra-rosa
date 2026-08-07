"use client";

import { useEffect, useState } from "react";
import { MIN_PASSWORD_LENGTH } from "@/lib/users";
import HelpButton from "@/components/HelpButton";
import ConfirmModal, { type ConfirmModalState } from "@/components/ConfirmModal";

interface User {
  id: number;
  name: string;
  email: string;
  role: "editor" | "viewer";
  mustChangePassword: boolean;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [me, setMe] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "viewer" });
  const [confirmState, setConfirmState] = useState<ConfirmModalState | null>(null);

  async function load() {
    const [u, whoami] = await Promise.all([
      fetch("/api/users").then((res) => res.json()),
      fetch("/api/users/me").then((res) => (res.ok ? res.json() : null)),
    ]);
    setUsers(Array.isArray(u) ? u : []);
    setMe(whoami?.id ?? null);
  }

  useEffect(() => {
    load();
  }, []);

  /** Runs a mutation, surfacing the API's error message on failure. */
  async function mutate(url: string, init: RequestInit, successMsg: string) {
    setError(null);
    setNotice(null);
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "Something went wrong.");
      return false;
    }
    setNotice(successMsg);
    load();
    return true;
  }

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    const ok = await mutate(
      "/api/users",
      { method: "POST", body: JSON.stringify(newUser) },
      `Added ${newUser.email}.`
    );
    if (ok) setNewUser({ name: "", email: "", password: "", role: "viewer" });
  }

  async function changeRole(user: User, role: string) {
    await mutate(
      `/api/users/${user.id}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
      `${user.email} is now ${role}.`
    );
  }

  function resetPassword(user: User) {
    setConfirmState({
      title: "Reset password?",
      message: `Generates a new temporary password for ${user.email} and forces them to choose their own at next login. Their current password stops working immediately.`,
      confirmLabel: "Reset",
      onConfirm: async () => {
        setError(null);
        setNotice(null);
        const res = await fetch(`/api/users/${user.id}/reset-password`, { method: "POST" });
        if (!res.ok) {
          setError((await res.json().catch(() => ({}))).error ?? "Could not reset password.");
          return;
        }
        const { tempPassword } = await res.json();
        // A real blocking popup rather than the page's own notice banner
        // (easy to miss/scroll past) — shown once, here, and never stored
        // or logged anywhere else. Same "editor hands it over out of band"
        // pattern as before, just with a generated password and a forced
        // change instead of a hand-typed one with no forcing function.
        window.alert(`Temporary password for ${user.email}: ${tempPassword} — they'll be asked to set their own at next login. Tell them now; this won't be shown again.`);
        load();
      },
    });
  }

  function removeUser(user: User) {
    setConfirmState({
      title: "Delete user?",
      message: `Delete ${user.email}? Bookings and notes they created stay, but stop showing their name. This cannot be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        await mutate(`/api/users/${user.id}`, { method: "DELETE" }, `Deleted ${user.email}.`);
      },
    });
  }

  return (
    <div className="tr-shell">
      <h1 style={{ fontSize: 18, marginBottom: 12 }}>Users</h1>
      <HelpButton title="Using Users">
        Editors can change everything; viewers can only read. You&apos;ll need to pass the password on to them
        yourself — it isn&apos;t emailed.
      </HelpButton>
      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}
      {notice && <p className="tr-badge tr-badge-ok" style={{ marginBottom: 12 }}>{notice}</p>}

      <div className="tr-card">
        <div className="tr-table-wrap">
          <table className="tr-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Added</th>
              <th className="tr-col-actions" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.name}
                  {u.id === me && <span className="tr-muted"> (you)</span>}
                </td>
                <td>
                  {u.email}
                  {u.mustChangePassword && (
                    <span className="tr-badge tr-badge-warn" style={{ marginLeft: 6, fontSize: 11 }} data-tooltip="Using a temporary password — will be asked to set their own at next login">
                      pending
                    </span>
                  )}
                </td>
                <td>
                  <select value={u.role} onChange={(e) => changeRole(u, e.target.value)}>
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td className="tr-muted">{u.createdAt?.slice(0, 10)}</td>
                <td className="tr-col-actions">
                  <button type="button" onClick={() => resetPassword(u)}>
                    Reset password
                  </button>{" "}
                  <button type="button" onClick={() => removeUser(u)} disabled={u.id === me}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      </div>

      <div className="tr-card">
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Add user</h2>
        <form onSubmit={addUser} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>Name</label>
            <input required value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>Email</label>
            <input
              type="email"
              required
              value={newUser.email}
              onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>Password</label>
            <input
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>Role</label>
            <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
            </select>
          </div>
          <button type="submit" className="primary">
            Add user
          </button>
        </form>
      </div>

      <ConfirmModal state={confirmState} onClose={() => setConfirmState(null)} />
    </div>
  );
}
