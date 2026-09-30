import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { CallsManager } from "./calls-manager";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function CallsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("calls");
  const user = await requireUser();
  const active = user?.subscription?.status === "ACTIVE";

  const calls = (await prisma.call.findMany({
    where: { userId: user!.id },
    orderBy: { timestamp: "desc" },
    take: 100,
    include: { lead: true },
  })).map((c) => ({
    id: c.id,
    lead: c.lead
      ? { id: c.lead.id, name: c.lead.name, phone: c.lead.phone, email: c.lead.email }
      : null,
    phoneNumber: c.phoneNumber,
    timestamp: c.timestamp.toISOString(),
    durationSecs: c.durationSecs,
    outcome: c.outcome,
    disposition: c.disposition,
    aiSummary: c.aiSummary,
    transcript: c.transcript,
    resultStatus: c.resultStatus,
    collectedData: c.collectedData,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
        <p className="text-sm text-slate-500">
          {t("subtitle")}
        </p>
      </div>
      <CallsManager initialCalls={calls} active={active} />
    </div>
  );
}
