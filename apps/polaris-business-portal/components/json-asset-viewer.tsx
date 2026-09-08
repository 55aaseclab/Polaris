"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

const MAX_VIEWER_BYTES = 5 * 1024 * 1024;

type JsonPrimitive = boolean | null | number | string;
type JsonObject = { [key: string]: JsonValue };
type JsonTree = JsonObject | JsonValue[];
type JsonValue = JsonPrimitive | JsonTree;

type JsonLine = {
  content: ReactNode;
  depth: number;
  key: string;
};

function isJsonTree(value: unknown): value is JsonTree {
  return Array.isArray(value) || (value !== null && typeof value === "object");
}

function isContainer(value: JsonValue): value is JsonTree {
  return Array.isArray(value) || (value !== null && typeof value === "object");
}

function jsonPath(parent: string, key: string | number) {
  return `${parent}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function JsonPrimitiveValue({ value }: { value: JsonPrimitive }) {
  if (typeof value === "string") {
    return <span className="text-emerald-700">{JSON.stringify(value)}</span>;
  }

  if (typeof value === "number") {
    return <span className="text-sky-700">{value}</span>;
  }

  return <span className="text-rose-700">{String(value)}</span>;
}

function JsonKey({ value }: { value: string }) {
  return <><span className="text-violet-700">{JSON.stringify(value)}</span><span className="text-muted-foreground">: </span></>;
}

function appendJsonLines({
  labels,
  collapsedPaths,
  depth,
  field,
  isLast,
  lines,
  onToggle,
  path,
  value,
}: {
  labels: { collapse: string; expand: string };
  collapsedPaths: ReadonlySet<string>;
  depth: number;
  field?: string;
  isLast: boolean;
  lines: JsonLine[];
  onToggle: (path: string) => void;
  path: string;
  value: JsonValue;
}) {
  const suffix = isLast ? null : <span className="text-muted-foreground">,</span>;
  const fieldPrefix = field === undefined ? null : <JsonKey value={field} />;

  if (!isContainer(value)) {
    lines.push({
      content: <>{fieldPrefix}<JsonPrimitiveValue value={value} />{suffix}</>,
      depth,
      key: `${path}:value`,
    });
    return;
  }

  const array = Array.isArray(value);
  const entries = array
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  const open = array ? "[" : "{";
  const close = array ? "]" : "}";

  if (entries.length === 0) {
    lines.push({
      content: <>{fieldPrefix}<span className="text-muted-foreground">{open}{close}</span>{suffix}</>,
      depth,
      key: `${path}:empty`,
    });
    return;
  }

  const collapsed = collapsedPaths.has(path);
  const ToggleIcon = collapsed ? ChevronRight : ChevronDown;
  const toggle = (
    <button
      aria-label={collapsed ? labels.expand : labels.collapse}
      className="mr-1 inline-flex size-5 -translate-y-px items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onToggle(path)}
      type="button"
    >
      <ToggleIcon className="size-3.5" aria-hidden="true" />
    </button>
  );

  if (collapsed) {
    lines.push({
      content: <>{toggle}{fieldPrefix}<span className="text-muted-foreground">{open}…{close}</span>{suffix}</>,
      depth,
      key: `${path}:collapsed`,
    });
    return;
  }

  lines.push({
    content: <>{toggle}{fieldPrefix}<span className="text-muted-foreground">{open}</span></>,
    depth,
    key: `${path}:open`,
  });

  entries.forEach(([key, item], index) => {
    appendJsonLines({
      labels,
      collapsedPaths,
      depth: depth + 1,
      field: array ? undefined : key,
      isLast: index === entries.length - 1,
      lines,
      onToggle,
      path: jsonPath(path, key),
      value: item,
    });
  });

  lines.push({
    content: <span className="text-muted-foreground">{close}{suffix}</span>,
    depth,
    key: `${path}:close`,
  });
}

function NumberedLines({ lines }: { lines: JsonLine[] }) {
  return (
    <div className="min-w-max py-3">
      {lines.map((line, index) => (
        <div className="grid min-h-6 grid-cols-[3.5rem_minmax(0,1fr)]" key={line.key}>
          <span className="select-none border-r pr-3 text-right text-muted-foreground">{index + 1}</span>
          <div className="min-w-0 whitespace-pre px-3" style={{ paddingInlineStart: `${line.depth * 1.25 + 0.75}rem` }}>
            {line.content}
          </div>
        </div>
      ))}
    </div>
  );
}

function NumberedRawJson({ value }: { value: string }) {
  const lines = value.split(/\r\n|\r|\n/);
  return <NumberedLines lines={lines.map((content, index) => ({ content, depth: 0, key: `raw:${index}` }))} />;
}

export function JsonAssetViewer({ source, size }: { source: string; size: number }) {
  const { t } = useI18n();
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const [data, setData] = useState<JsonTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [raw, setRaw] = useState("");

  useEffect(() => {
    if (size > MAX_VIEWER_BYTES) {
      setData(null);
      setError(null);
      setLoading(false);
      setRaw("");
      return;
    }

    const controller = new AbortController();
    setCollapsedPaths(new Set());
    setData(null);
    setError(null);
    setLoading(true);
    setRaw("");

    fetch(source, { signal: controller.signal })
      .then(async (response) => {
        const text = await response.text();
        if (!response.ok) {
          throw new Error(t("jsonViewer.unableToLoad", { status: response.status }, `无法加载 JSON（${response.status}）`));
        }
        return text;
      })
      .then((text) => {
        if (controller.signal.aborted) return;
        setRaw(text);
        try {
          const parsed: unknown = JSON.parse(text);
          if (isJsonTree(parsed)) setData(parsed as JsonTree);
          else setError(t("jsonViewer.rootNotObject", undefined, "JSON 根节点不是对象或数组，已原样展示。"));
        } catch {
          setError(t("jsonViewer.invalidFormat", undefined, "JSON 格式无效，已原样展示。"));
        }
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

  const togglePath = useCallback((path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const lines = useMemo(() => {
    if (!data) return [];
    const next: JsonLine[] = [];
    appendJsonLines({
      labels: {
        collapse: t("jsonViewer.collapseNode", undefined, "收起 JSON 节点"),
        expand: t("jsonViewer.expandNode", undefined, "展开 JSON 节点"),
      },
      collapsedPaths,
      depth: 0,
      isLast: true,
      lines: next,
      onToggle: togglePath,
      path: "$",
      value: data,
    });
    return next;
  }, [collapsedPaths, data, t, togglePath]);

  if (size > MAX_VIEWER_BYTES) {
    return (
      <div className="flex h-full items-center p-6">
        <div>
          <h2 className="font-medium">{t("jsonViewer.tooLargeTitle", undefined, "JSON 文件过大")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t("jsonViewer.tooLargeDescription", undefined, "为保证工作台响应速度，超过 5 MB 的 JSON 不会在内置查看器中展开。")}</p>
          <a className="mt-4 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline" href={source} rel="noreferrer" target="_blank">
            {t("jsonViewer.openInNewWindow", undefined, "在新窗口打开")}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-auto overscroll-contain bg-card font-mono text-sm leading-6">
      {loading ? <p className="p-4 font-sans text-muted-foreground">{t("jsonViewer.loading", undefined, "正在加载 JSON…")}</p> : null}
      {!loading && data ? <NumberedLines lines={lines} /> : null}
      {!loading && !data && error ? <>
        <p className="p-4 pb-0 font-sans text-sm text-destructive">{error}</p>
        <NumberedRawJson value={raw} />
      </> : null}
    </div>
  );
}
