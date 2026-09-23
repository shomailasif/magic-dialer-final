"use client";

import { useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { Button, Card, CardHeader, Alert } from "@/components/ui";

export function ShareRcButton({
  customerId,
  hasDialerConfig,
  sipUsername,
}: {
  customerId: string;
  hasDialerConfig: boolean;
  sipUsername: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function shareRc() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/customers/${customerId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voipShared: true }),
      });
      const data = await res.json();
      setLoading(false);
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to share RC" });
        return;
      }
      setMessage({ type: "success", text: "RingCentral credentials shared successfully" });
      router.refresh();
    } catch {
      setLoading(false);
      setMessage({ type: "error", text: "Failed to share RC" });
    }
  }

  return (
    <Card>
      <CardHeader title="VOIP Configuration" description="Share RingCentral SIP credentials with this customer" />
      <div className="space-y-3 p-5">
        {message && (
          <Alert tone={message.type === "success" ? "success" : "error"}>{message.text}</Alert>
        )}
        {hasDialerConfig ? (
          <div>
            <p className="text-sm text-slate-500">Current SIP username</p>
            <p className="font-medium text-slate-900">{sipUsername}</p>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No VOIP configured yet</p>
        )}
        <Button onClick={shareRc} loading={loading} className="w-full">
          {hasDialerConfig ? "Re-share RC Credentials" : "Share RC Credentials"}
        </Button>
      </div>
    </Card>
  );
}
