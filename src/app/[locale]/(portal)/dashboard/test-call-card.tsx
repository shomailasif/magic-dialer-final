"use client";

import { useState } from "react";
import { Card, Button, Input } from "@/components/ui";

export function TestCallCard() {
  const [number, setNumber] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function launchLocalCall() {
    if (!number.trim()) return;
    setLoading(true);
    setStatus("Connecting this PC to your account...");
    try {
      const r = await fetch("/api/engine/enrollment-ticket", { method: "POST" });
      const e = await r.json();
      if (!r.ok || !e.ticket) throw new Error(e.error || "Could not enroll this PC");
      const local = new URL("http://127.0.0.1:48771/");
      local.searchParams.set("enroll", e.ticket);
      local.searchParams.set("portal", window.location.origin);
      local.searchParams.set("call", number.trim());
      window.location.assign(local.toString());
    } catch (err) {
      setLoading(false);
      setStatus("PC connection failed: " + (err instanceof Error ? err.message : "unknown error"));
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
        <Button onClick={launchLocalCall} loading={loading} disabled={!number.trim()}>
          Call test
        </Button>
      </div>
      {status && (
        <p className="mt-3 text-sm text-slate-600">{status}</p>
      )}
    </Card>
  );
}
