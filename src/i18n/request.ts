import * as rootParams from "next/root-params";
import { notFound } from "next/navigation";
import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";

export default getRequestConfig(async ({ locale }) => {
  const requestedLocale = locale ?? (await rootParams.locale());

  if (!hasLocale(routing.locales, requestedLocale)) {
    notFound();
  }

  return {
    locale: requestedLocale,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    messages: (await import(`../../messages/${requestedLocale}.json`)).default,
    timeZone: "UTC",
  };
});
