import { Link } from "@/i18n/navigation";
import { prisma } from "@/lib/db";
import { requireAdmin, getAdminId } from "@/lib/auth";
import { Card, Badge, StatCard } from "@/components/ui";
import { PLAN_BY_ID } from "@/lib/constants";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

const statusTone: Record<string, string> = {
  ACTIVE: "green",
  PENDING: "amber",
  SUSPENDED: "red",
  DEACTIVATED: "red",
};

export default async function SubscriptionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("subscriptions");
  const tpl = await getTranslations("plans");
  const te = await getTranslations("enums");
  const admin = await requireAdmin();
  const adminId = admin.id;

  const userFilter = { role: "BUSINESS_ADMIN" as const, createdByAdminId: adminId };

  const [subscriptions, totalActive] = await Promise.all([
    prisma.subscription.findMany({
      where: { user: userFilter },
      include: { user: true, history: { orderBy: { changedAt: "desc" }, take: 5 } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.subscription.count({ where: { status: "ACTIVE", user: userFilter } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
        <p className="text-sm text-slate-500">
          {t("subtitle")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label={t("statTotal")} value={subscriptions.length} />
        <StatCard label={t("statActive")} value={totalActive} tone="green" />
        <StatCard label={t("statPending")} value={subscriptions.filter((s) => s.status === "PENDING").length} tone="amber" />
        <StatCard label={t("statSuspended")} value={subscriptions.filter((s) => s.status === "SUSPENDED").length} tone="red" />
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">{t("colCustomer")}</th>
                <th className="px-5 py-3 font-medium">{t("colPlan")}</th>
                <th className="px-5 py-3 font-medium">{t("colStatus")}</th>
                <th className="px-5 py-3 font-medium">{t("colActivated")}</th>
                <th className="px-5 py-3 font-medium">{t("colNextBilling")}</th>
                <th className="px-5 py-3 font-medium">{t("colHistory")}</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {subscriptions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                    {t("empty")}
                  </td>
                </tr>
              ) : (
                subscriptions.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">
                      {s.user.companyName || s.user.email}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {PLAN_BY_ID[s.plan] ? tpl(`names.${PLAN_BY_ID[s.plan].id}`) : s.plan}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={statusTone[s.status] || "slate"}>
                        {te(`subscriptionStatus.${s.status}`)}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {s.startedAt ? new Date(s.startedAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {s.nextBilling ? new Date(s.nextBilling).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-5 py-3">
                      {s.history.length > 0 ? (
                        <span className="text-slate-500">
                          {s.history
                            .slice(0, 2)
                            .map(
                              (h) =>
                                `${PLAN_BY_ID[h.plan] ? tpl(`names.${PLAN_BY_ID[h.plan].id}`) : h.plan} → ${
                                  te(`subscriptionStatus.${h.status}`)
                                }`,
                            )
                            .join(", ")}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/admin/customers/${s.userId}`}
                        className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
                      >
                        {t("manageLink")}
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
