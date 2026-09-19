"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";

export function ConnectPcButton({ connected = false, lastSeenAt = null }: { connected?: boolean; lastSeenAt?: string | null }) {
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(connected);
  const [status, setStatus] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== "http://127.0.0.1:48771") return;
      if (event.data?.type === "magic-dialer-enrolled") {
        setLoading(false); setIsConnected(true); setStatus(null); setDialog(true);
      } else if (event.data?.type === "magic-dialer-enrollment-failed") {
        setLoading(false); setStatus(event.data?.error || "PC connection failed");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function connectPc() {
    setLoading(true); setStatus("Connecting this PC...");
    try {
      const r = await fetch("/api/engine/enrollment-ticket", { method: "POST" });
      const e = await r.json();
      if (!r.ok || !e.ticket) throw new Error(e.error || "Could not create secure PC connection");
      const local = new URL("http://127.0.0.1:48771/");
      local.searchParams.set("enroll", e.ticket);
      local.searchParams.set("portal", window.location.origin);
      const popup = window.open(local.toString(), "magicDialerConnect", "popup=yes,width=520,height=300");
      if (!popup) throw new Error("Allow the Magic Dialer connection popup, then try again.");
    } catch (err) {
      setLoading(false); setStatus(err instanceof Error ? err.message : "PC connection failed");
    }
  }

  return (
    <>
      <div className="flex flex-col gap-2 sm:items-end">
        <div className="flex flex-wrap gap-2">
          <Button href="https://github.com/shomailasif/magic-dialer-final/releases/download/engine-latest/magic-dialer-engine-windows.exe" variant="outline">Download for Windows</Button>
          <Button onClick={connectPc} loading={loading}>{isConnected ? "Reconnect this PC" : "Connect this PC"}</Button>
        </div>
        {isConnected && <p className="text-xs font-medium text-emerald-700">● Connected{lastSeenAt ? ` · last seen ${new Date(lastSeenAt).toLocaleString()}` : ""}</p>}
        {status && <p className="text-xs text-slate-600">{status}</p>}
      </div>
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-slate-900">This PC is connected</h3>
            <p className="mt-2 text-sm text-slate-600">Magic Dialer is securely linked to your account.</p>
            <div className="mt-5 flex justify-end"><Button onClick={() => setDialog(false)}>Close</Button></div>
          </div>
        </div>
      )}
    </>
  );
}
