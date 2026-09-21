import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { DialerSettings } from "./dialer-settings";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function DialerPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dialer");
  const user = await getCurrentUser();
  const config = user ? await prisma.dialerConfig.findUnique({ where: { userId: user.id } }) : null;
  const active = user?.subscription?.status === "ACTIVE";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
        <p className="text-sm text-slate-500">
          {t("subtitle")}
        </p>
      </div>
      <DialerSettings
        initial={{
          provider: config?.provider || "TWILIO",
          apiKey: config?.apiKey || "",
          accountSid: config?.accountSid || "",
          outboundNumber: config?.outboundNumber || "",
          sipUsername: config?.sipUsername || "",
          sipPassword: config?.sipPassword ? "••••••••" : "",
          sipAuthId: config?.sipAuthId || "",
          sipDomain: config?.sipDomain || "",
          sipProxy: config?.sipProxy || "",
          sipPort: config?.sipPort || "",
          validated: config?.validated || false,
        }}
        active={active}
      />
    </div>
  );
}
