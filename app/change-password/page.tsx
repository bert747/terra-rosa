"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MIN_PASSWORD_LENGTH } from "@/lib/users";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      setSaving(false);
      setError((await res.json().catch(() => ({}))).error ?? "Could not change password.");
      return;
    }
    router.push("/grid");
  }

  return (
    <div className="tr-shell" style={{ maxWidth: 380, marginTop: 60 }}>
      <div className="tr-card">
        <h1 style={{ fontSize: 18, marginBottom: 4 }}>Choose a new password</h1>
        <p className="tr-muted" style={{ fontSize: 13, marginBottom: 12 }}>
          You're using a temporary password. Set your own before continuing.
        </p>
        {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", marginBottom: 2 }}>New password</label>
            <input
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", marginBottom: 2 }}>Confirm password</label>
            <input
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
          <button type="submit" className="primary" style={{ width: "100%" }} disabled={saving}>
            {saving ? "Saving…" : "Set password"}
          </button>
        </form>
      </div>
    </div>
  );
}
