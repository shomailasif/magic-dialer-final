"use client";

import { useState } from "react";
import { Card, Button, Input } from "@/components/ui";

export function TestCallCard() {
  const [number, setNumber] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function dialTest() {
    if (!number.trim()) return;
    setLoading(true);
    setStatus("Verifying this PC against the current portal...");
    let popup: Window | null = window.open("about:blank", "magicDialerTestCall", "popup=yes,width=520,height=300");
    if (!popup) {
      setLoading(false);
      setStatus("Call failed: Allow the Magic Dialer test-call popup, then try again.");
      return;
    }

    const localBase = "http://127.0.0.1:48771/";
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== "http://127.0.0.1:48771" || event.source !== popup) return;
      if (event.data?.type === "magic-dialer-enrolled") {
        setStatus("PC verified. Starting test call...");
        const local = new URL(localBase);
        local.searchParams.set("call", number.trim());
        try { if (popup && !popup.closed) popup.location.href = local.toString(); }
        catch {
          setLoading(false);
          setStatus("Call failed: Could not continue in the local-engine popup.");
          window.removeEventListener("message", onMessage);
        }
      } else if (event.data?.type === "magic-dialer-enrollment-failed") {
        setStatus("Call failed: " + (event.data?.error || "PC verification failed"));
        setLoading(false);
        window.removeEventListener("message", onMessage);
      } else if (event.data?.type === "magic-dialer-call-complete") {
        setStatus("Test call completed through this PC.");
        setLoading(false);
        window.removeEventListener("message", onMessage);
      } else if (event.data?.type === "magic-dialer-call-failed") {
        setStatus("Call failed: " + (event.data?.error || "Local call failed"));
        setLoading(false);
        window.removeEventListener("message", onMessage);
      }
    };
    window.addEventListener("message", onMessage);

    try {
      const r = await fetch("/api/engine/enrollment-ticket", { method: "POST" });
      const e = await r.json();
      if (!r.ok || !e.ticket) throw new Error(e.error || "Could not verify this PC");
      const local = new URL(localBase);
      local.searchParams.set("enroll", e.ticket);
      local.searchParams.set("portal", window.location.origin);
      popup.location.href = local.toString();
    } catch (err) {
      window.removeEventListener("message", onMessage);
      try { popup.close(); } catch {}
      setLoading(false);
      setStatus("Call failed: " + (err instanceof Error ? err.message : "PC verification failed"));
    }
  }

  return (
    <Card className="p-5">
      <h3 className="text-base font-semibold text-slate-900">Test Call</h3>
      <p className="mt-1 text-sm text-slate-500">
        Place a test call to verify your VOIP line is working before going live.
      </p>
      <div className="mt-4 flex gap-2">
        <Input
          placeholder="+16234001991"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          className="flex-1"
        />
        <Button onClick={dialTest} loading={loading} disabled={!number.trim()}>
          Call test
        </Button>
      </div>
      {status && (
        <p className="mt-3 text-sm text-slate-600">{status}</p>
      )}
    </Card>
  );
}
