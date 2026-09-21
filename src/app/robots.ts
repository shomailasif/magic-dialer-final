import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/en/dashboard", "/fr/dashboard", "/es/dashboard", "/de/dashboard", "/pt/dashboard", "/it/dashboard", "/nl/dashboard", "/ru/dashboard", "/uk/dashboard", "/pl/dashboard", "/tr/dashboard", "/ar/dashboard", "/he/dashboard", "/zh/dashboard", "/ja/dashboard", "/ko/dashboard", "/hi/dashboard", "/id/dashboard", "/vi/dashboard", "/ur/dashboard"],
    },
  };
}
