"use client";

export interface ToastMessage {
  id: number;
  text: string;
}

export default function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 1000,
        maxWidth: 360,
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="tr-card"
          style={{
            padding: "10px 12px",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
          }}
        >
          <span style={{ flex: 1, fontSize: 13 }}>{toast.text}</span>
          <button type="button" onClick={() => onDismiss(toast.id)} style={{ fontSize: 12 }}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
