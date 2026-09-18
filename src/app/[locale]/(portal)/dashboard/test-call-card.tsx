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
    setStatus("Checking local Magic Dialer engine...");
    try {
      const localFetch = (url: string, init: RequestInit = {}) => fetch(url, { ...init, targetAddressSpace: "local" } as RequestInit & { targetAddressSpace: "local" });
      const health = await localFetch("http://127.0.0.1:18787/health", { cache: "no-store" });
      const hj = await health.json();
      if (!health.ok || hj?.service !== "magic-dialer-engine" || hj?.callControl !== true) throw new Error("Local Magic Dialer engine is not ready. Start or update the Windows engine.");
      setStatus(`Local engine v${hj.version} online — placing test call...`);
      const res = await localFetch("http://127.0.0.1:18787/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: number.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Failed: ${data.error || "Unknown error"}`);
      } else {
        setStatus("Local-engine test call completed.");
      }
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : "Network error"}`);
    } finally {
      setLoading(false);
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
