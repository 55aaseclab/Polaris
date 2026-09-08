"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/i18n-provider";

const MAX_VIEWER_BYTES = 5 * 1024 * 1024;

type TextLine = {
  content: string;
  key: string;
};

function NumberedText({ text }: { text: string }) {
  const lines: TextLine[] = text
    .split(/\r\n|\r|\n/)
    .map((content, index) => ({ content, key: `line:${index}` }));

  return (
    <div className="min-w-max py-3 font-mono text-xs leading-5">
      {lines.map((line, index) => (
        <div className="grid min-h-6 grid-cols-[3.5rem_minmax(0,1fr)]" key={line.key}>
          <span className="select-none border-r pr-3 text-right text-muted-foreground">{index + 1}</span>
          <pre className="min-w-0 overflow-visible whitespace-pre px-3 text-foreground">{line.content}</pre>
        </div>
      ))}
    </div>
  );
}

export function TextAssetViewer({ source, size }: { source: string; size: number }) {
  const { t } = useI18n();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (size > MAX_VIEWER_BYTES) {
      setContent("");
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setContent("");
    setError(null);
    setLoading(true);

    fetch(source, { signal: controller.signal })
      .then(async (response) => {
        const text = await response.text();
        if (!response.ok) {
          throw new Error(t("textViewer.unableToLoad", { status: response.status }, `无法加载文本（${response.status}）`));
        }
        return text;
      })
      .then((text) => {
        if (controller.signal.aborted) return;
        setContent(text);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [size, source, t]);

  if (size > MAX_VIEWER_BYTES) {
    return (
      <div className="flex h-full items-center p-6">
        <div>
          <h2 className="font-medium">{t("textViewer.tooLargeTitle", undefined, "文本文件过大")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t("textViewer.tooLargeDescription", undefined, "为保证工作台响应速度，超过 5 MB 的文本不会在内置查看器中展开。")}</p>
          <a className="mt-4 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline" href={source} rel="noreferrer" target="_blank">
            {t("textViewer.openInNewWindow", undefined, "在新窗口打开")}
          </a>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">{t("textViewer.loading", undefined, "正在加载文本…")}</div>;
  }

  if (error) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">{error}</p>
        <a className="mt-4 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline" href={source} rel="noreferrer" target="_blank">
          {t("textViewer.openInNewWindow", undefined, "在新窗口打开")}
        </a>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto overscroll-contain">
      <NumberedText text={content} />
    </div>
  );
}
