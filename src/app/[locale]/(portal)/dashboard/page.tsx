import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { Card, StatCard, Badge, Button } from "@/components/ui";
import { CallOutcome, LeadStatus } from "@prisma/client";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { TestCallCard } from "./test-call-card";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

function statusTone(status: string) {
  switch (status) {
    case "INTERESTED":
      return "blue";
    case "CONVERTED":
      return "green";
    case "NOT_INTERESTED":
      return "slate";
    case "FAILED":
      return "red";
    case "PENDING":
      return "amber";
    default:
      return "slate";
  }
}

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");
  const te = await getTranslations("enums");
  const tc = await getTranslations("common");
  const user = await getCurrentUser();

  const [totalLeads, calls, recentCalls, pendingLeads, interestedCount, convertedCount] =
    await Promise.all([
      prisma.lead.count({ where: { userId: user!.id } }),
      prisma.call.count({ where: { userId: user!.id } }),
      prisma.call.findMany({
        where: { userId: user!.id },
        orderBy: { timestamp: "desc" },
        take: 8,
        include: { lead: true },
      }),
      prisma.lead.count({
        where: { userId: user!.id, OR: [{ status: "PENDING" }, { status: "FAILED" }] },
      }),
      prisma.lead.count({ where: { userId: user!.id, status: "INTERESTED" } }),
      prisma.lead.count({ where: { userId: user!.id, status: "CONVERTED" } }),
    ]);

  const active = user?.subscription?.status === "ACTIVE";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
          <p className="text-sm text-slate-500">
            {t("subtitle", { name: user?.name || user?.companyName || t("greetingFallback") })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button href="/leads" variant="outline">{t("uploadLeads")}</Button>
          <Button href="/dashboard" disabled={!active} loading={false}>{t("startCampaign")}</Button>
        </div>
      </div>

      <Card className="border-indigo-200 bg-indigo-50 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-indigo-700">One-time PC setup</p>
            <h2 className="mt-1 text-lg font-bold text-slate-900">Download Magic Dialer</h2>
            <p className="mt-1 text-sm text-slate-600">Install the Windows engine on this PC once. After installation, use Magic Dialer from this panel normally.</p>
          </div>
          <Button href="https://github.com/shomailasif/magic-dialer-final/releases/download/engine-latest/magic-dialer-engine-windows.exe" variant="primary">Download for Windows</Button>
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label={t("statTotalLeads")} value={totalLeads} tone="indigo" />
        <StatCard label={t("statCallsMade")} value={calls} />
        <StatCard label={t("statCallsPending")} value={pendingLeads} sub={t("statCallsPendingSub")} tone="amber" />
        <StatCard label={t("statInterested")} value={interestedCount} tone="blue" />
        <StatCard label={t("statConversions")} value={convertedCount} tone="green" />
      </div>

      {!active && (
        <Card className="p-5">
          <p className="text-sm text-slate-600">
            {t("inactiveCard")}
          </p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <h3 className="text-base font-semibold text-slate-900">{t("recentActivity")}</h3>
              <Link href="/calls" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
                {t("viewAll")}
              </Link>
            </div>
            {recentCalls.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-slate-500">
                {t("noCallsEmpty")}
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recentCalls.map((c) => (
                  <li key={c.id} className="flex items-center justify-between px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold ${
                          c.outcome === "CONNECTED" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {c.lead?.name ? c.lead.name.charAt(0).toUpperCase() : "?"}
                      </span>
                      <div>
                        <p className="text-sm font-medium text-slate-900">{c.lead?.name || t("fallbackName")}</p>
                        <p className="text-xs text-slate-500">
                          {te(`outcome.${c.outcome}`)} · {c.durationSecs ? `${c.durationSecs}s` : tc("emptyCell")} ·{" "}
                          {new Date(c.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    {c.resultStatus && <Badge tone={statusTone(c.resultStatus)}>{te(`leadStatus.${c.resultStatus}`)}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <TestCallCard />

          <Card className="p-5">
            <h3 className="text-base font-semibold text-slate-900">{t("quickActions")}</h3>
            <div className="mt-4 space-y-2">
              <Link
                href="/leads"
                className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <span aria-hidden>📤</span> {t("quickUploadLeads")}
              </Link>
              <Link
                href="/agent"
                className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <span aria-hidden>🤖</span> {t("quickConfigureAgent")}
              </Link>
              <Link
                href="/calls"
                className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <span aria-hidden>📊</span> {t("quickViewReports")}
              </Link>
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="text-base font-semibold text-slate-900">{t("breakdownHeading")}</h3>
            <div className="mt-4 space-y-2 text-sm">
              {([
                ["PENDING", t("breakdownPending"), totalLeads - (interestedCount + convertedCount)],
                ["INTERESTED", t("breakdownInterested"), interestedCount],
                ["CONVERTED", t("breakdownConverted"), convertedCount],
              ] as const).map(([key, label, count]) => (
                <div key={key} className="flex items-center justify-between">
                  <span className="text-slate-600">{label}</span>
                  <span className="font-semibold text-slate-900">{count}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
