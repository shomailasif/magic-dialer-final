import { Link } from "@/i18n/navigation";
import { prisma } from "@/lib/db";
import { requireAdmin, getAdminId } from "@/lib/auth";
import { StatCard, Card, Badge, Button } from "@/components/ui";
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

export default async function AdminDashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("adminOverview");
  const tpl = await getTranslations("plans");
  const te = await getTranslations("enums");
  const admin = await requireAdmin();
  const adminId = admin.id;

  const where = { role: "BUSINESS_ADMIN" as const, createdByAdminId: adminId };

  const [totalAccounts, active, pending, suspended, deactivated, customers] =
    await Promise.all([
      prisma.user.count({ where }),
      prisma.subscription.count({ where: { status: "ACTIVE", user: where } }),
      prisma.subscription.count({ where: { status: "PENDING", user: where } }),
      prisma.subscription.count({ where: { status: "SUSPENDED", user: where } }),
      prisma.subscription.count({ where: { status: "DEACTIVATED", user: where } }),
      prisma.user.findMany({
        where,
        include: {
          subscription: true,
          _count: { select: { leads: true, calls: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
          <p className="text-sm text-slate-500">{t("subtitle")}</p>
        </div>
        <Button href="/admin/customers">{t("manageCustomers")}</Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label={t("statTotalAccounts")} value={totalAccounts} tone="indigo" />
        <StatCard label={t("statActive")} value={active} tone="green" />
        <StatCard label={t("statPending")} value={pending} tone="amber" />
        <StatCard label={t("statSuspended")} value={suspended} tone="red" />
        <StatCard label={t("statDeactivated")} value={deactivated} />
      </div>

      <Card>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-base font-semibold text-slate-900">{t("recentTitle")}</h3>
          <Link href="/admin/customers" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
            {t("viewAll")}
          </Link>
        </div>
        {customers.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-500">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">{t("colCompany")}</th>
                  <th className="px-5 py-3 font-medium">{t("colEmail")}</th>
                  <th className="px-5 py-3 font-medium">{t("colPlan")}</th>
                  <th className="px-5 py-3 font-medium">{t("colStatus")}</th>
                  <th className="px-5 py-3 font-medium">{t("colLeads")}</th>
                  <th className="px-5 py-3 font-medium">{t("colCalls")}</th>
                  <th className="px-5 py-3 font-medium">{t("colRegistered")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {customers.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">
                      <Link href={`/admin/customers/${c.id}`} className="hover:text-indigo-600">
                        {c.companyName || c.name || "—"}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-slate-600">{c.email}</td>
                    <td className="px-5 py-3 text-slate-600">
                      {c.subscription && PLAN_BY_ID[c.subscription.plan]
                        ? tpl(`names.${PLAN_BY_ID[c.subscription.plan].id}`)
                        : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={statusTone[c.subscription?.status || ""] || "slate"}>
                        {c.subscription ? te(`subscriptionStatus.${c.subscription.status}`) : "—"}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-slate-600">{c._count.leads}</td>
                    <td className="px-5 py-3 text-slate-600">{c._count.calls}</td>
                    <td className="px-5 py-3 text-slate-600">{new Date(c.createdAt).toLocaleDateString()}</td>
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
