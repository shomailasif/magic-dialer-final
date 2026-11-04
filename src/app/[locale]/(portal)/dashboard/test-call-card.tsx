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
    setStatus("Confirm this PC in the popup window to continue.");
    const popup = window.open("about:blank", "magicDialerTestCall", "popup=yes,width=520,height=340");
    if (!popup) {
      setLoading(false);
      setStatus("Call failed: Allow the Magic Dialer test-call popup, then try again.");
      return;
    }
    const win = popup;

    const localBase = "http://127.0.0.1:48771/";
    let settled = false;
    let poll: number | undefined;
    const stopWatching = () => {
      window.removeEventListener("message", onMessage);
      if (poll !== undefined) window.clearInterval(poll);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      stopWatching();
      setLoading(false);
      setStatus(message);
    };

    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== "http://127.0.0.1:48771" || event.source !== win) return;
      if (event.data?.type === "magic-dialer-enrolled") {
        if (settled) return;
        settled = true;
        if (poll !== undefined) window.clearInterval(poll);
        setStatus("PC verified. Starting test call...");
        try { if (!win.closed) win.close(); } catch {}
        /* Call control is a POST to the same endpoint the dashboard uses.
         * The open-main-page GET that used to trigger a call could be started
         * by any website, so the engine no longer offers it; this request is
         * accepted because the PC has just enrolled to this exact origin. */
        try {
          const r = await fetch(localBase + "api/call", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ number: number.trim() }),
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || "Local call failed");
          setStatus("Test call completed through this PC.");
        } catch (err) {
          /* The PC is verified at this point, so this is the call itself
           * failing; `fail` is already settled and would swallow it. */
          setStatus("Call failed: " + (err instanceof Error ? err.message : "Local call failed"));
        } finally {
          window.removeEventListener("message", onMessage);
          setLoading(false);
        }
      } else if (event.data?.type === "magic-dialer-enrollment-failed") {
        fail("Call failed: " + (event.data?.error || "PC verification failed"));
      }
    };
    window.addEventListener("message", onMessage);

    /* The PC asks for a click before it joins a portal, so the user may take a
     * while - or close the window. Nothing used to notice either, and the card
     * sat on "Verifying..." forever with the button spinning. */
    const deadline = Date.now() + 90000;
    poll = window.setInterval(() => {
      if (settled) return;
      if (win.closed) {
        fail("Call failed: the verification window was closed before this PC was connected.");
      } else if (Date.now() > deadline) {
        try { win.close(); } catch {}
        fail("Call failed: this PC did not confirm the connection in time.");
      }
    }, 800);

    try {
      const r = await fetch("/api/engine/enrollment-ticket", { method: "POST" });
      const e = await r.json();
      if (!r.ok || !e.ticket) throw new Error(e.error || "Could not verify this PC");
      const local = new URL(localBase);
      local.searchParams.set("enroll", e.ticket);
      local.searchParams.set("portal", window.location.origin);
      win.location.href = local.toString();
    } catch (err) {
      try { win.close(); } catch {}
      fail("Call failed: " + (err instanceof Error ? err.message : "PC verification failed"));
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
