"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

export function ConnectPcButton() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function connectPc() {
    setLoading(true);
    setStatus("Connecting this PC...");
    try {
      const r = await fetch("/api/engine/enrollment-ticket", { method: "POST" });
      const e = await r.json();
      if (!r.ok || !e.ticket) throw new Error(e.error || "Could not create secure PC connection");
      const local = new URL("http://127.0.0.1:48771/");
      local.searchParams.set("enroll", e.ticket);
      local.searchParams.set("portal", window.location.origin);
      window.location.assign(local.toString());
    } catch (err) {
      setLoading(false);
      setStatus(err instanceof Error ? err.message : "PC connection failed");
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <Button href="https://github.com/shomailasif/magic-dialer-final/releases/download/engine-latest/magic-dialer-engine-windows.exe" variant="outline">
          Download for Windows
        </Button>
        <Button onClick={connectPc} loading={loading}>Connect this PC</Button>
      </div>
      {status && <p className="text-xs text-slate-600">{status}</p>}
    </div>
  );
}
