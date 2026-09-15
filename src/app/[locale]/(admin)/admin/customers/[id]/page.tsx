import { prisma } from "@/lib/db";
import { requireAdmin, getAdminId } from "@/lib/auth";
import { Badge, Card, CardHeader, StatCard, EmptyState } from "@/components/ui";
import { PLAN_BY_ID } from "@/lib/constants";
import { CustomerActions } from "./customer-actions";
import { getTranslations, setRequestLocale } from "next-intl/server";

const statusTone: Record<string, string> = {
  ACTIVE: "green",
  PENDING: "amber",
  SUSPENDED: "red",
  DEACTIVATED: "red",
};

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("customerDetail");
  const tpl = await getTranslations("plans");
  const te = await getTranslations("enums");
  const admin = await requireAdmin();
  const adminId = admin.id;

  const customer = await prisma.user.findFirst({
    where: { id, role: "BUSINESS_ADMIN", createdByAdminId: adminId },
    include: {
      subscription: true,
      agentConfig: true,
      dialerConfig: true,
      _count: { select: { leads: true, calls: true } },
    },
  });

  if (!customer) {
    return (
      <EmptyState title={t("notFoundTitle")} description={t("notFoundDesc")} />
    );
  }

  const recentCalls = await prisma.call.findMany({
    where: { userId: id },
    orderBy: { timestamp: "desc" },
    take: 10,
    include: { lead: true },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{customer.companyName || t("fallbackHeading")}</h1>
          <p className="text-sm text-slate-500">
            {customer.email} · registered {new Date(customer.createdAt).toLocaleDateString()}
          </p>
        </div>
        {customer.subscription && (
          <Badge tone={statusTone[customer.subscription.status] || "slate"}>
            {te(`subscriptionStatus.${customer.subscription.status}`)}
          </Badge>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label={t("statLeads")} value={customer._count.leads} tone="indigo" />
        <StatCard label={t("statCalls")} value={customer._count.calls} />
        <StatCard
          label={t("statPlan")}
          value={
            customer.subscription && PLAN_BY_ID[customer.subscription.plan]
              ? tpl(`names.${PLAN_BY_ID[customer.subscription.plan].id}`)
              : "—"
          }
        />
        <StatCard
          label={t("statDialer")}
          value={customer.dialerConfig?.validated ? t("dialerConnected") : t("dialerNotConnected")}
          tone={customer.dialerConfig?.validated ? "green" : "amber"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <CustomerActions
          customerId={customer.id}
          currentPlan={customer.subscription?.plan || ""}
          currentStatus={customer.subscription?.status || "PENDING"}
        />

        <Card>
          <CardHeader title={t("configTitle")} />
          <div className="space-y-3 p-5 text-sm">
            {customer.agentConfig ? (
              <>
                <div>
                  <p className="text-slate-500">{t("productLabel")}</p>
                  <p className="font-medium text-slate-900">
                    {customer.agentConfig.productName || t("configEmpty")}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">{t("toneLabel")}</p>
                  <p className="font-medium text-slate-900">
                    {te(`agentTone.${customer.agentConfig.tone}`)}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">{t("followUpsLabel")}</p>
                  <p className="font-medium text-slate-900">
                    {t("followUpsValue", {
                      n: customer.agentConfig.followUpAttempts,
                      m: customer.agentConfig.followUpIntervalHours,
                    })}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">{t("audienceLabel")}</p>
                  <p className="font-medium text-slate-900">{customer.agentConfig.targetAudience || "—"}</p>
                </div>
              </>
            ) : (
              <p className="text-slate-500">{t("configEmpty")}</p>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title={t("callsTitle")} action=""></CardHeader>
        {recentCalls.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">{t("callsEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">{t("colLead")}</th>
                  <th className="px-5 py-3 font-medium">{t("colPhone")}</th>
                  <th className="px-5 py-3 font-medium">{t("colWhen")}</th>
                  <th className="px-5 py-3 font-medium">{t("colOutcome")}</th>
                  <th className="px-5 py-3 font-medium">{t("colResult")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentCalls.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">{c.lead?.name || t("fallbackName")}</td>
                    <td className="px-5 py-3 text-slate-600">{c.lead?.phone || "—"}</td>
                    <td className="px-5 py-3 text-slate-600">{new Date(c.timestamp).toLocaleString()}</td>
                    <td className="px-5 py-3 text-slate-600">{te(`outcome.${c.outcome}`)}</td>
                    <td className="px-5 py-3 text-slate-600">
                      {c.resultStatus ? te(`leadStatus.${c.resultStatus}`) : "—"}
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
