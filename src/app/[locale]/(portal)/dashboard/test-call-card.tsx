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
    setStatus("Opening the connected Magic Dialer engine...");
    let popup: Window | null = null;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== "http://127.0.0.1:48771" || event.source !== popup) return;
      if (event.data?.type === "magic-dialer-call-complete") {
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
      const local = new URL("http://127.0.0.1:48771/");
      local.searchParams.set("call", number.trim());
      popup = window.open(local.toString(), "magicDialerTestCall", "popup=yes,width=520,height=300");
      if (!popup) throw new Error("Allow the Magic Dialer test-call popup, then try again.");
    } catch (err) {
      window.removeEventListener("message", onMessage);
      setLoading(false);
      setStatus("Call failed: " + (err instanceof Error ? err.message : "local engine handoff failed"));
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
