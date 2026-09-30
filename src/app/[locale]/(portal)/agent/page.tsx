import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { AgentForm } from "./agent-form";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function AgentPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("agent");
  const user = await requireUser();
  const config = user ? await prisma.aIAgentConfig.findUnique({ where: { userId: user.id } }) : null;
  const active = user?.subscription?.status === "ACTIVE";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
        <p className="text-sm text-slate-500">
          {t("subtitle")}
        </p>
      </div>
      <AgentForm initial={config} disabled={!active} />
    </div>
  );
}
