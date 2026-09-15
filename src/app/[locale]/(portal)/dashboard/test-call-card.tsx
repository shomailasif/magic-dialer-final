"use client";

import { useState } from "react";
import { Card, Button, Input } from "@/components/ui";

export function TestCallCard() {
  const [number, setNumber] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function dialTest() {
    setLoading(true);
    setStatus("Testing VOIP connection...");
    try {
      const res = await fetch("/api/dialer/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "RINGCENTRAL", outboundNumber: number.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Connection failed: ${data.error || "Check your VOIP settings"}`);
      } else {
        setStatus(`Connection successful! Your VOIP line is active and ready.`);
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
          placeholder="Optional: outbound number"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          className="flex-1"
        />
        <Button onClick={dialTest} loading={loading}>
          Test connection
        </Button>
      </div>
      {status && (
        <p className="mt-3 text-sm text-slate-600">{status}</p>
      )}
    </Card>
  );
}
