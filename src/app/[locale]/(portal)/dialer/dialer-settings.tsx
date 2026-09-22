"use client";

import { useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Button, Card, CardHeader, Input, Select, Label, FormField, Alert, Badge } from "@/components/ui";
import type { DialerProvider } from "@prisma/client";

interface Props {
  initial: {
    provider: DialerProvider;
    apiKey: string;
    accountSid: string;
    outboundNumber: string;
    sipUsername: string;
    sipPassword: string;
    sipAuthId: string;
    sipDomain: string;
    sipProxy: string;
    sipPort: string;
    validated: boolean;
  };
  active: boolean;
}

export function DialerSettings({ initial, active }: Props) {
  const router = useRouter();
  const t = useTranslations("dialerSettings");
  const te = useTranslations("enums");
  const [provider, setProvider] = useState<DialerProvider>(initial.provider);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [accountSid, setAccountSid] = useState(initial.accountSid);
  const [outboundNumber, setOutboundNumber] = useState(initial.outboundNumber);
  const [sipUsername, setSipUsername] = useState(initial.sipUsername);
  const [sipPassword, setSipPassword] = useState(initial.sipPassword);
  const [sipAuthId, setSipAuthId] = useState(initial.sipAuthId);
  const [sipDomain, setSipDomain] = useState(initial.sipDomain || "sip.ringcentral.com");
  const [sipProxy, setSipProxy] = useState(initial.sipProxy || "sip40.ringcentral.com");
  const [sipPort, setSipPort] = useState(initial.sipPort || "5096");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  async function testConnection() {
    setMessage(null);
    setTesting(true);
    const res = await fetch("/api/dialer/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, apiKey, accountSid, outboundNumber, sipUsername, sipPassword, sipAuthId, sipDomain, sipProxy, sipPort }),
    });
    const data = await res.json();
    setTesting(false);
    if (!res.ok) {
      setMessage({ type: "error", text: data.error || t("testError") });
      return;
    }
    setMessage({ type: "success", text: data.message });
  }

  async function save() {
    setMessage(null);
    setSaving(true);
    const payload: Record<string, string> = { provider, apiKey, accountSid, outboundNumber, sipUsername, sipAuthId, sipDomain, sipProxy, sipPort };
    if (sipPassword === "") {
      payload.sipPassword = "";
    } else if (sipPassword && sipPassword !== "••••••••") {
      payload.sipPassword = sipPassword;
    }
    const res = await fetch("/api/dialer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setMessage({ type: "error", text: data.error || t("saveError") });
      return;
    }
    setMessage({ type: "success", text: t("saveSuccess") });
    router.refresh();
  }

  return (
    <div className="max-w-2xl space-y-6">
      {!active && (
        <Alert tone="warning">
          {t("disabledWarning")}
        </Alert>
      )}
      {message && (
        <Alert tone={message.type === "success" ? "success" : "error"}>{message.text}</Alert>
      )}

      <Card>
        <CardHeader
          title={t("providerTitle")}
          description={t("providerDesc")}
          action={
            initial.validated ? (
              <Badge tone="green">{t("connected")}</Badge>
            ) : (
              <Badge tone="amber">{t("notConnected")}</Badge>
            )
          }
        />
        <div className="grid gap-4 p-5">
          <FormField label={t("providerLabel")}>
            <Select
              value={provider}
              onChange={(e) => setProvider(e.target.value as DialerProvider)}
            >
              <option value="TWILIO">{te("dialerProvider.TWILIO")}</option>
              <option value="RINGCENTRAL">{te("dialerProvider.RINGCENTRAL")}</option>
              <option value="VONAGE">{te("dialerProvider.VONAGE")}</option>
            </Select>
          </FormField>
          <FormField label={t("apiKeyLabel")}>
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider === "TWILIO" ? t("apiKeyTwilioPlaceholder") : t("apiKeyPlaceholder")}
              type="password"
            />
          </FormField>
          <FormField label={t("sidLabel")}>
            <Input
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value)}
              placeholder={t("sidPlaceholder")}
              type="password"
            />
          </FormField>
          <FormField label={t("outboundLabel")} hint={t("outboundHint")}>
            <Input
              value={outboundNumber}
              onChange={(e) => setOutboundNumber(e.target.value)}
              placeholder={t("outboundPlaceholder")}
            />
          </FormField>

          {provider === "RINGCENTRAL" && (
            <div className="grid gap-4 rounded-lg border border-slate-200 p-4">
              <div>
                <div className="text-sm font-semibold text-slate-900">RingCentral SIP for the local calling engine</div>
                <div className="mt-1 text-xs text-slate-500">These credentials are delivered only to your enrolled PC. The password is never shown again after saving.</div>
              </div>
              <FormField label="SIP username">
                <Input value={sipUsername} onChange={(e) => setSipUsername(e.target.value)} autoComplete="off" />
              </FormField>
              <FormField label="SIP password">
                <Input value={sipPassword} onChange={(e) => setSipPassword(e.target.value)} type="password" autoComplete="new-password" />
              </FormField>
              <FormField label="Authorization ID">
                <Input value={sipAuthId} onChange={(e) => setSipAuthId(e.target.value)} placeholder="Defaults to SIP username" />
              </FormField>
              <FormField label="SIP domain">
                <Input value={sipDomain} onChange={(e) => setSipDomain(e.target.value)} />
              </FormField>
              <FormField label="Outbound proxy">
                <Input value={sipProxy} onChange={(e) => setSipProxy(e.target.value)} />
              </FormField>
              <FormField label="TLS port">
                <Input value={sipPort} onChange={(e) => setSipPort(e.target.value)} inputMode="numeric" />
              </FormField>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button variant="outline" onClick={testConnection} loading={testing}>
              {t("testButton")}
            </Button>
            <Button onClick={save} loading={saving}>
              {t("saveButton")}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("howTitle")} />
        <div className="space-y-2 p-5 text-sm text-slate-600">
          <p>{t("howBullet1")}</p>
          <p>{t("howBullet2")}</p>
          <p>{t("howBullet3")}</p>
        </div>
      </Card>
    </div>
  );
}
