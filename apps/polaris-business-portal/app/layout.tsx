import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { I18nProvider } from "@/components/i18n-provider";
import { Toaster } from "@/components/ui/sonner";
import {
  ADMIN_PORTAL_DEFAULT_LOCALE,
  ADMIN_PORTAL_LOCALE_COOKIE,
  coerceAdminPortalLocale,
  getAdminPortalText,
} from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const locale = coerceAdminPortalLocale(
    cookieStore.get(ADMIN_PORTAL_LOCALE_COOKIE)?.value ?? ADMIN_PORTAL_DEFAULT_LOCALE,
  );
  return {
    title: getAdminPortalText(locale, "meta.title", undefined, "望海工作台"),
    description: getAdminPortalText(locale, "meta.description", undefined, "工作区运营门户"),
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const locale = coerceAdminPortalLocale(cookieStore.get(ADMIN_PORTAL_LOCALE_COOKIE)?.value ?? ADMIN_PORTAL_DEFAULT_LOCALE);
  return (
    <html lang={locale} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <I18nProvider initialLocale={locale}>
          {children}
        </I18nProvider>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
