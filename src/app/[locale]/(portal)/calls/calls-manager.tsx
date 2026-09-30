"use client";

import { useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Button, Card, StatCard, Badge, EmptyState, Alert, Input, Label, Select } from "@/components/ui";

interface CallView {
  id: string;
  lead: { id: string; name: string | null; phone: string | null; email: string | null } | null;
  phoneNumber: string | null;
  timestamp: string;
  durationSecs: number | null;
  outcome: string;
  disposition: string | null;
  aiSummary: string | null;
  transcript: string | null;
  resultStatus: string | null;
  collectedData: string | null;
}

interface Report {
  totalCalls: number;
  connected: number;
  interested: number;
  converted: number;
  failedAttempts: number;
  connectionRate: number;
  interestRate: number;
  conversionRate: number;
}

const statusTone: Record<string, string> = {
  INTERESTED: "blue",
  CONVERTED: "green",
  NOT_INTERESTED: "slate",
  FAILED: "red",
  PENDING: "amber",
};

const STATUSES = ["PENDING", "CALLED", "INTERESTED", "CONVERTED", "NOT_INTERESTED", "FAILED"];

export function CallsManager({
  initialCalls,
  active,
}: {
  initialCalls: CallView[];
  active: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("callsManager");
  const te = useTranslations("enums");
  const [calls, setCalls] = useState<CallView[]>(initialCalls);
  const [report, setReport] = useState<Report | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [outcome, setOutcome] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [loading, setLoading] = useState(false);
  const [campaigning, setCampaigning] = useState(false);
  const [campaignMsg, setCampaignMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [selected, setSelected] = useState<CallView | null>(null);

  async function refresh() {
    setLoading(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (outcome !== "ALL") params.set("outcome", outcome);
    if (status !== "ALL") params.set("status", status);
    const res = await fetch(`/api/calls?${params.toString()}`);
    const data = await res.json();
    setCalls(data.calls);
    setReport(data.report);
    setLoading(false);
  }

  async function runCampaign() {
    setCampaignMsg(null);
    setCampaigning(true);
    try {
      const res = await fetch("/api/campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 20 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCampaignMsg({ type: "error", text: data.error || t("campaignError") });
        return;
      }
      /* The campaign runs in the background, so this returns at once instead of
       * holding the button until every call is finished. The old version waited
       * for the whole run, which on an account with 500 leads meant the button
       * spun until the proxy gave up and nothing was ever shown. */
      setCampaignMsg({
        type: "success",
        text: data.message || t("campaignSuccess", { n: 0, m: 0, k: 0 }),
      });
      router.refresh();
      refresh();
      // Follow the run so the list fills in as calls land.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const p = await (await fetch("/api/campaign?campaignId=" + (data.campaignId || ""))).json();
          if (p && p.running === false && p.campaign) { router.refresh(); refresh(); break; }
          refresh();
        } catch { /* keep polling */ }
      }
    } catch (e) {
      setCampaignMsg({ type: "error", text: e instanceof Error ? e.message : t("campaignError") });
    } finally {
      setCampaigning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label>{t("fromLabel")}</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </div>
          <div>
            <Label>{t("toLabel")}</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
          <div>
            <Label>{t("outcomeLabel")}</Label>
            <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="w-36">
              <option value="ALL">{t("allOutcomes")}</option>
              {Object.keys(te.raw("outcome") as Record<string, string>).map((k) => (
                <option key={k} value={k}>{te(`outcome.${k}`)}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t("leadStatusLabel")}</Label>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
              <option value="ALL">{t("allStatuses")}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{te(`leadStatus.${s}`)}</option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" onClick={refresh} loading={loading}>{t("filterButton")}</Button>
        </div>
        <Button onClick={runCampaign} loading={campaigning} disabled={!active}>
          {active ? t("launchCampaign") : t("subscriptionRequired")}
        </Button>
      </div>

      {campaignMsg && (
        <Alert tone={campaignMsg.type === "success" ? "success" : "error"}>{campaignMsg.text}</Alert>
      )}

      {report && (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label={t("statTotalCalls")} value={report.totalCalls} />
          <StatCard label={t("statConnected")} value={report.connected} />
          <StatCard label={t("statInterested")} value={report.interested} tone="blue" />
          <StatCard label={t("statConverted")} value={report.converted} tone="green" />
          <StatCard label={t("statFailed")} value={report.failedAttempts} tone="red" />
          <StatCard label={t("statConversionRate")} value={`${report.conversionRate}%`} />
        </div>
      )}

      {report && (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">{t("reportTitle")}</h3>
          <div className="mt-3 grid grid-cols-3 gap-4 text-sm">
            {[
              [t("metricConnection"), `${report.connectionRate}%`],
              [t("metricInterest"), `${report.interestRate}%`],
              [t("metricConversion"), `${report.conversionRate}%`],
            ].map(([k, v]) => (
              <div key={k as string}>
                <p className="text-slate-500">{k}</p>
                <p className="text-lg font-bold text-slate-900">{v}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="text-base font-semibold text-slate-900">{t("historyTitle")}</h3>
        </div>
        {calls.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={t("emptyTitle")}
              description={t("emptyDesc")}
              action={<Button onClick={runCampaign} disabled={!active}>{t("emptyButton")}</Button>}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">{t("colLead")}</th>
                  <th className="px-5 py-3 font-medium">{t("colPhone")}</th>
                  <th className="px-5 py-3 font-medium">{t("colWhen")}</th>
                  <th className="px-5 py-3 font-medium">{t("colDuration")}</th>
                  <th className="px-5 py-3 font-medium">{t("colOutcome")}</th>
                  <th className="px-5 py-3 font-medium">{t("colResult")}</th>
                  <th className="px-5 py-3 text-right font-medium">{t("colDetail")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {calls.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">
                      {c.lead?.name || t("fallbackName")}
                    </td>
                    <td className="px-5 py-3 text-slate-600">{c.lead?.phone || c.phoneNumber || "—"}</td>
                    <td className="px-5 py-3 text-slate-600">{new Date(c.timestamp).toLocaleString()}</td>
                    <td className="px-5 py-3 text-slate-600">{c.durationSecs ? `${c.durationSecs}s` : "—"}</td>
                    <td className="px-5 py-3">
                      <Badge tone={c.outcome === "CONNECTED" ? "green" : "slate"}>
                        {te(`outcome.${c.outcome}`)}
                      </Badge>
                    </td>
                    <td className="px-5 py-3">
                      {c.resultStatus ? (
                        <Badge tone={statusTone[c.resultStatus] || "slate"}>
                          {te(`leadStatus.${c.resultStatus}`)}
                        </Badge>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => setSelected(c)}
                        className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
                      >
                        {t("viewButton")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setSelected(null)}>
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">{selected.lead?.name || t("modalTitle")}</h3>
                <p className="text-sm text-slate-500">
                  {selected.lead?.phone || selected.phoneNumber} · {selected.lead?.email || t("noEmail")}
                </p>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-slate-500">{t("fieldTimestamp")}</p>
                <p className="font-medium text-slate-900">{new Date(selected.timestamp).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-slate-500">{t("fieldDuration")}</p>
                <p className="font-medium text-slate-900">{selected.durationSecs ? `${selected.durationSecs}s` : "—"}</p>
              </div>
              <div>
                <p className="text-slate-500">{t("fieldOutcome")}</p>
                <p className="font-medium text-slate-900">{te(`outcome.${selected.outcome}`)}</p>
              </div>
              <div>
                <p className="text-slate-500">{t("fieldDisposition")}</p>
                <p className="font-medium text-slate-900">{selected.disposition || "—"}</p>
              </div>
            </div>
            {selected.aiSummary && (
              <div className="mt-4">
                <p className="text-sm font-semibold text-slate-900">{t("sectionSummary")}</p>
                <p className="mt-1 text-sm text-slate-600">{selected.aiSummary}</p>
              </div>
            )}
            {selected.collectedData && (
              <div className="mt-4">
                <p className="text-sm font-semibold text-slate-900">{t("sectionCollected")}</p>
                <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                  {JSON.stringify(JSON.parse(selected.collectedData), null, 2)}
                </pre>
              </div>
            )}
            {selected.transcript ? (
              <div className="mt-4">
                <p className="text-sm font-semibold text-slate-900">{t("sectionTranscript")}</p>
                <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
                  {selected.transcript}
                </pre>
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-400">{t("noTranscript")}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
