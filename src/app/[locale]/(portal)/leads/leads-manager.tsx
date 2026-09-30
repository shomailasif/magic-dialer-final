"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Button, Card, CardHeader, Input, Select, Badge, EmptyState, Alert, Label, FormField } from "@/components/ui";
import type { LeadStatus } from "@prisma/client";

interface LeadView {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  status: LeadStatus;
  lastCallAt: Date | null;
  disposition: string | null;
  extraData: Record<string, string> | null;
}

const statusTone: Record<string, string> = {
  PENDING: "amber",
  CALLED: "blue",
  INTERESTED: "blue",
  CONVERTED: "green",
  NOT_INTERESTED: "slate",
  FAILED: "red",
};

const ALL_STATUSES: LeadStatus[] = [
  "PENDING",
  "CALLED",
  "INTERESTED",
  "CONVERTED",
  "NOT_INTERESTED",
  "FAILED",
];

export function LeadsManager({
  initialLeads,
  initialCounts,
  active,
}: {
  initialLeads: LeadView[];
  initialCounts: Record<string, number>;
  active: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("leadsManager");
  const te = useTranslations("enums");
  const [leads, setLeads] = useState<LeadView[]>(initialLeads);
  const [counts, setCounts] = useState<Record<string, number>>(initialCounts);
  const [filter, setFilter] = useState<string>("ALL");
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [genIndustry, setGenIndustry] = useState("");
  const [genGeo, setGenGeo] = useState("");
  const [genSize, setGenSize] = useState("");
  const [genCount, setGenCount] = useState(8);
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState(false);

  const filtered = useMemo(() => {
    if (filter === "ALL") return leads;
    return leads.filter((l) => l.status === filter);
  }, [leads, filter]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setNotice(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      /* Read the body as text first. A server-side failure returns an HTML
       * error page, and `res.json()` on that throws "Unexpected token '<'",
       * which told the user nothing and looked like the upload was broken
       * forever. Text first means we can show what actually went wrong, and a
       * blip is worth one automatic retry before bothering anyone. */
      let res = await fetch("/api/leads", { method: "POST", body: fd });
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1200));
        res = await fetch("/api/leads", { method: "POST", body: fd });
      }
      const raw = await res.text();
      let data: { error?: string; imported?: number; failed?: number } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(
          res.status >= 500
            ? "The server had a problem saving your file. Please try again."
            : "The upload was rejected before it was saved. Please try again.",
        );
      }
      if (!res.ok) throw new Error(data.error || t("importError"));
      setNotice({
        type: "success",
        text: t("importSuccess", { n: String(data.imported ?? 0), m: String(data.failed ?? 0) }),
      });
      router.refresh();
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      setNotice({ type: "error", text: err instanceof Error ? err.message : t("uploadError") });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onGenerate() {
    setNotice(null);
    setGenerating(true);
    try {
      const res = await fetch("/api/leads/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          industry: genIndustry,
          geography: genGeo,
          companySize: genSize,
          count: genCount,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || t("generationError"));
      setNotice({ type: "success", text: data.message });
      router.refresh();
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      setNotice({ type: "error", text: err instanceof Error ? err.message : t("generationError") });
    } finally {
      setGenerating(false);
    }
  }

  async function deleteLead(id: string) {
    if (!confirm(t("deleteConfirm"))) return;
    const res = await fetch(`/api/leads/${id}`, { method: "DELETE" });
    if (res.ok) {
      setLeads((ls) => ls.filter((l) => l.id !== id));
      router.refresh();
    }
  }

  async function updateStatus(id: string, status: string) {
    const res = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      setLeads((ls) =>
        ls.map((l) => (l.id === id ? { ...l, status: status as LeadStatus } : l)),
      );
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
      {notice && <Alert tone={notice.type === "success" ? "success" : "error"}>{notice.text}</Alert>}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title={t("uploadTitle")} description={t("uploadDesc")} />
          <div className="p-5">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={onUpload}
            />
            <div
              onClick={() => fileRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 px-4 py-8 text-center hover:border-indigo-400 hover:bg-indigo-50/50"
            >
              <svg className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              <p className="mt-2 text-sm font-medium text-slate-700">
                {uploading ? t("uploadLoading") : t("uploadIdle")}
              </p>
              <p className="mt-1 text-xs text-slate-400">{t("formatHint")}</p>
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title={t("aiTitle")} description={t("aiDesc")} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <FormField label={t("industryLabel")}>
              <Input value={genIndustry} onChange={(e) => setGenIndustry(e.target.value)} placeholder={t("industryPlaceholder")} />
            </FormField>
            <FormField label={t("geographyLabel")}>
              <Input value={genGeo} onChange={(e) => setGenGeo(e.target.value)} placeholder={t("geographyPlaceholder")} />
            </FormField>
            <FormField label={t("sizeLabel")}>
              <Select value={genSize} onChange={(e) => setGenSize(e.target.value)}>
                <option value="">{te("companySize.any")}</option>
                <option value="1-10">1-10</option>
                <option value="11-50">11-50</option>
                <option value="50-200">50-200</option>
                <option value="200+">200+</option>
              </Select>
            </FormField>
            <FormField label={t("countLabel")}>
              <Input
                type="number"
                min={1}
                max={50}
                value={genCount}
                onChange={(e) => setGenCount(Number(e.target.value))}
              />
            </FormField>
            <div className="sm:col-span-2">
              <Button onClick={onGenerate} loading={generating} disabled={!active}>
                {active ? t("generateButton") : t("subscriptionRequired")}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title={t("tableTitle")}
          action={
            <div className="w-44">
              <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="ALL">{t("allStatuses")}</option>
                {ALL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {te(`leadStatus.${s}`)} ({counts[s] || 0})
                  </option>
                ))}
              </Select>
            </div>
          }
        />
        {filtered.length === 0 ? (
          <div className="p-5">
            <EmptyState title={t("emptyTitle")} description={t("emptyDesc")} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">{t("colName")}</th>
                  <th className="px-5 py-3 font-medium">{t("colPhone")}</th>
                  <th className="px-5 py-3 font-medium">{t("colEmail")}</th>
                  <th className="px-5 py-3 font-medium">{t("colCompany")}</th>
                  <th className="px-5 py-3 font-medium">{t("colStatus")}</th>
                  <th className="px-5 py-3 font-medium">{t("colLastCall")}</th>
                  <th className="px-5 py-3 font-medium">{t("colDisposition")}</th>
                  <th className="px-5 py-3 text-right font-medium">{t("colActions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">{l.name || "—"}</td>
                    <td className="px-5 py-3 text-slate-600">{l.phone || "—"}</td>
                    <td className="px-5 py-3 text-slate-600">{l.email || "—"}</td>
                    <td className="px-5 py-3 text-slate-600">{l.company || "—"}</td>
                    <td className="px-5 py-3">
                      <Badge tone={statusTone[l.status] || "slate"}>{te(`leadStatus.${l.status}`)}</Badge>
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {l.lastCallAt ? new Date(l.lastCallAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="max-w-[180px] truncate px-5 py-3 text-slate-600" title={l.disposition || ""}>
                      {l.disposition || "—"}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <Select
                          className="w-36 py-1.5"
                          value={l.status}
                          onChange={(e) => updateStatus(l.id, e.target.value)}
                        >
                          {ALL_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {te(`leadStatus.${s}`)}
                            </option>
                          ))}
                        </Select>
                        <button
                          onClick={() => deleteLead(l.id)}
                          className="text-sm text-rose-600 hover:text-rose-800"
                          aria-label={t("deleteAria")}
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
