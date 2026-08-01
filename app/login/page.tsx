export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="tr-shell" style={{ maxWidth: 380, marginTop: 60 }}>
      <div className="tr-card">
        <h1 style={{ fontSize: 18, marginBottom: 12 }}>Terra Rosa — Log in</h1>
        {params.error && (
          <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>
            Incorrect email or password.
          </p>
        )}
        <form action="/api/auth/login" method="post">
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", marginBottom: 2 }}>Email</label>
            <input type="email" name="email" required style={{ width: "100%" }} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", marginBottom: 2 }}>Password</label>
            <input type="password" name="password" required style={{ width: "100%" }} />
          </div>
          <button type="submit" className="primary" style={{ width: "100%" }}>
            Log in
          </button>
        </form>
      </div>
    </div>
  );
}
