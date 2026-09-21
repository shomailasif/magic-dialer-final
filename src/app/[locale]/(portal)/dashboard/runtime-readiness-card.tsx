"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";

type Proof = { ok?: boolean; schema?: string; singlePcLease?: boolean; automaticEnrollment?: boolean };

export function RuntimeReadinessCard() {
  const [proof, setProof] = useState<Proof | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/engine/runtime-proof", { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok || !body.ok) throw new Error(body.schema === "unavailable" ? "Deployment database is not ready" : "Runtime proof failed");
        return body;
      })
      .then((body) => { if (live) setProof(body); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Runtime proof failed"); });
    return () => { live = false; };
  }, []);

  const ready = !!(proof?.ok && proof.schema === "engine-enrollment-v2" && proof.singlePcLease && proof.automaticEnrollment);
  return (
    <Card className={`p-4 ${ready ? "border-emerald-200 bg-emerald-50" : error ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Deployment readiness</p>
          <p className="mt-1 text-xs text-slate-600">
            {ready ? "Portal database, automatic enrollment, and single-PC lease are ready." : error || "Checking deployed portal and database..."}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${ready ? "bg-emerald-100 text-emerald-700" : error ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
          {ready ? "READY" : error ? "BLOCKED" : "CHECKING"}
        </span>
      </div>
    </Card>
  );
}
