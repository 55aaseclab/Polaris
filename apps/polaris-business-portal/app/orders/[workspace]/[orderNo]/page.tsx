"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

/**
 * Legacy order detail route.
 * Redirect into the new left/center/right workspace shell with order management open.
 */
export default function OrderRoutePage({
  params,
}: {
  params: Promise<{ workspace: string; orderNo: string }>;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [message, setMessage] = useState(() => t("orderRoute.opening", undefined, "正在打开订单管理…"));

  useEffect(() => {
    let cancelled = false;
    params
      .then((value) => {
        if (cancelled) return;
        const workspace = decodeURIComponent(value.workspace);
        const orderNo = decodeURIComponent(value.orderNo);
        const search = new URLSearchParams({
          workspace,
          order: orderNo,
          view: "order-management",
        });
        router.replace(`/?${search.toString()}`);
      })
      .catch(() => {
        if (!cancelled) {
          setMessage(t("orderRoute.invalidRoute", undefined, "无法解析订单路径，请从工作台打开订单管理。"));
          router.replace("/");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [params, router, t]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/20 p-6 text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        {message}
      </div>
    </main>
  );
}
