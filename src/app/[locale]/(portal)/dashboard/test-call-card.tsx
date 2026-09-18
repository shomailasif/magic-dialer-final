"use client";

import { useState } from "react";
import { Card, Button, Input } from "@/components/ui";

export function TestCallCard() {
  const [number, setNumber] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function launchLocalCall() {
    if (!number.trim()) return;
    setLoading(true);
    setStatus("Opening the installed Magic Dialer engine...");
    const local = new URL("http://127.0.0.1:48771/");
    local.searchParams.set("call", number.trim());
    window.location.assign(local.toString());
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
