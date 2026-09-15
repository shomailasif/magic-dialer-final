import { Link } from "@/i18n/navigation";
import { prisma } from "@/lib/db";
import { requireAdmin, getAdminId } from "@/lib/auth";
import { Card, Badge } from "@/components/ui";
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

export default async function CustomersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("customers");
  const tpl = await getTranslations("plans");
  const te = await getTranslations("enums");
  const admin = await requireAdmin();
  const adminId = admin.id;

  const customers = await prisma.user.findMany({
    where: { role: "BUSINESS_ADMIN", createdByAdminId: adminId },
    include: {
      subscription: true,
      _count: { select: { leads: true, calls: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
        <p className="text-sm text-slate-500">{t("subtitle")}</p>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">{t("colCompany")}</th>
                <th className="px-5 py-3 font-medium">{t("colContact")}</th>
                <th className="px-5 py-3 font-medium">{t("colPlan")}</th>
                <th className="px-5 py-3 font-medium">{t("colStatus")}</th>
                <th className="px-5 py-3 font-medium">{t("colLeads")}</th>
                <th className="px-5 py-3 font-medium">{t("colCalls")}</th>
                <th className="px-5 py-3 font-medium">{t("colRegistered")}</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {customers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-slate-500">
                    {t("empty")}
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">{c.companyName || "—"}</td>
                    <td className="px-5 py-3 text-slate-600">{c.email}</td>
                    <td className="px-5 py-3 text-slate-600">
                      {c.subscription && PLAN_BY_ID[c.subscription.plan]
                        ? tpl(`names.${PLAN_BY_ID[c.subscription.plan].id}`)
                        : "—"}
                    </td>
                    <td className="px-5 py-3">
                      {c.subscription && (
                        <Badge tone={statusTone[c.subscription.status] || "slate"}>
                          {te(`subscriptionStatus.${c.subscription.status}`)}
                        </Badge>
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-600">{c._count.leads}</td>
                    <td className="px-5 py-3 text-slate-600">{c._count.calls}</td>
                    <td className="px-5 py-3 text-slate-600">{new Date(c.createdAt).toLocaleDateString()}</td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/admin/customers/${c.id}`}
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
