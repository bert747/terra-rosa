"use client";

import { useState, type ReactNode } from "react";

/**
 * A small "?" affordance fixed in a page's bottom-left corner, popping open
 * the page's own usage notes on click — keeps that explanatory text out of
 * the way of everyday use (it was previously a permanent paragraph on the
 * page) while still being one click away for anyone who wants it.
 */
export default function HelpButton({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "fixed", bottom: 16, left: 16, zIndex: 45 }}>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 44 }} onClick={() => setOpen(false)} />
          <div className="tr-help-popover" style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 45 }}>
            <div className="tr-help-popover-title">{title}</div>
            <div className="tr-help-popover-body">{children}</div>
          </div>
        </>
      )}
      <button type="button" className="tr-help-button" aria-label="Help" data-tooltip="Help" onClick={() => setOpen((v) => !v)}>
        ?
      </button>
    </div>
  );
}
