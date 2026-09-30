import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PLAN_BY_ID } from "@/lib/constants";
import { AccountClient } from "./account-client";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function AccountPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("account");
  const tpl = await getTranslations("plans");
  const te = await getTranslations("enums");
  const user = await requireUser();

  const [subscription, history, notifications] = await Promise.all([
    prisma.subscription.findUnique({ where: { userId: user!.id } }),
    prisma.subscriptionHistory.findMany({
      where: { sub: { userId: user!.id } },
      orderBy: { changedAt: "desc" },
      take: 10,
    }),
    prisma.notification.findMany({
      where: { userId: user!.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  const plan = subscription ? PLAN_BY_ID[subscription.plan] : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
        <p className="text-sm text-slate-500">
          {t("subtitle")}
        </p>
      </div>

      <AccountClient
        user={{
          name: user?.name || null,
          email: user?.email || "",
        }}
        subscription={{
          plan: subscription?.plan || null,
          planName: plan ? tpl(`names.${plan.id}`) : "—",
          status: subscription?.status || "PENDING",
          statusLabel:
            (subscription && te(`subscriptionStatus.${subscription.status}`)) || t("fallbackStatus"),
          startedAt: subscription?.startedAt?.toISOString() ?? null,
          nextBilling: subscription?.nextBilling?.toISOString() ?? null,
        }}
        history={history.map((h) => ({
          plan: PLAN_BY_ID[h.plan] ? tpl(`names.${PLAN_BY_ID[h.plan].id}`) : h.plan,
          status: te(`subscriptionStatus.${h.status}`),
          changedAt: h.changedAt.toISOString(),
        }))}
        notifications={notifications.map((n) => ({
          id: n.id,
          subject: n.subject,
          leadName: n.leadName,
          status: n.status as string,
          createdAt: n.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
