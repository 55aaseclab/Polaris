<script setup lang="ts">
import { useData } from "vitepress";
import { computed, ref } from "vue";
import { docsDiffs, docsVersions, type DocsDiffData, type DocsVersionData } from "../generated/docs-data";

type DiffSegment = {
  type: "same" | "added" | "removed";
  text: string;
};

type SideBySideRow = {
  leftNumber: number | null;
  rightNumber: number | null;
  leftText: string;
  rightText: string;
  leftType: "same" | "added" | "removed";
  rightType: "same" | "added" | "removed";
  leftSegments?: DiffSegment[];
  rightSegments?: DiffSegment[];
};

type UnifiedRow = {
  kind: "meta" | "hunk" | "added" | "removed" | "context";
  marker: string;
  text: string;
  leftNumber: number | null;
  rightNumber: number | null;
};

type SyntaxToken = {
  text: string;
  cls: string | null;
};

const { frontmatter } = useData();
const diffs = docsDiffs as DocsDiffData[];
const versions = docsVersions as DocsVersionData[];
const diffMode = ref<"unified" | "split">("unified");

const filePath = computed(() => String(frontmatter.value.diffPath ?? ""));
const pageTitle = computed(() => String(frontmatter.value.title ?? filePath.value));
const leftVersion = computed(() => String(frontmatter.value.leftVersion ?? "0.2.2"));
const rightVersion = computed(() => String(frontmatter.value.rightVersion ?? "latest"));

const leftFile = computed(
  () =>
    versions
      .find((entry) => entry.version === leftVersion.value)
      ?.files.find((file) => file.path === filePath.value),
);

const rightFile = computed(
  () =>
    versions
      .find((entry) => entry.version === rightVersion.value)
      ?.files.find((file) => file.path === filePath.value),
);

const unifiedPatch = computed(() => {
  const direct = diffs.find(
    (entry) =>
      entry.leftVersion === leftVersion.value
      && entry.rightVersion === rightVersion.value
      && entry.path === filePath.value,
  );
  return direct?.unified || "No textual differences.";
});

const unifiedRows = computed(() => parseUnifiedPatch(unifiedPatch.value));
const visibleUnifiedRows = computed(() =>
  unifiedRows.value.filter((row) => row.kind !== "meta"),
);
const sideBySideRows = computed(() =>
  buildSideBySideRows(leftFile.value?.content ?? "", rightFile.value?.content ?? ""),
);

function tokenizeSyntax(text: string): SyntaxToken[] {
  if (!text) {
    return [{ text: "", cls: null }];
  }

  const headingMatch = /^(#{1,6})(\s+)(.*)$/.exec(text);
  if (headingMatch) {
    return [
      { text: headingMatch[1]!, cls: "syntax-heading-mark" },
      { text: headingMatch[2]!, cls: null },
      { text: headingMatch[3]!, cls: "syntax-heading-text" },
    ];
  }

  const bulletMatch = /^(\s*[-*+] )(.+)$/.exec(text);
  if (bulletMatch) {
    return [
      { text: bulletMatch[1]!, cls: "syntax-bullet" },
      { text: bulletMatch[2]!, cls: null },
    ];
  }

  const orderedMatch = /^(\s*\d+\.\s+)(.+)$/.exec(text);
  if (orderedMatch) {
    return [
      { text: orderedMatch[1]!, cls: "syntax-bullet" },
      { text: orderedMatch[2]!, cls: null },
    ];
  }

  const pattern = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))/g;
  const tokens: SyntaxToken[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, index), cls: null });
    }
    const value = match[0] ?? "";
    tokens.push({
      text: value,
      cls: value.startsWith("`") ? "syntax-code" : "syntax-link",
    });
    lastIndex = index + value.length;
  }

  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), cls: null });
  }

  return tokens.length > 0 ? tokens : [{ text, cls: null }];
}

function normalizeLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function tokenizeInline(value: string): string[] {
  return value.split(/(\s+|[^\w\s])/g).filter(Boolean);
}

function buildSequenceDiff<T>(
  left: T[],
  right: T[],
  equals: (leftValue: T, rightValue: T) => boolean,
): Array<
  | { type: "same"; left: T; right: T; leftIndex: number; rightIndex: number }
  | { type: "removed"; left: T; leftIndex: number }
  | { type: "added"; right: T; rightIndex: number }
> {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      dp[leftIndex]![rightIndex] = equals(left[leftIndex]!, right[rightIndex]!)
        ? dp[leftIndex + 1]![rightIndex + 1]! + 1
        : Math.max(dp[leftIndex + 1]![rightIndex]!, dp[leftIndex]![rightIndex + 1]!);
    }
  }

  const result: Array<
    | { type: "same"; left: T; right: T; leftIndex: number; rightIndex: number }
    | { type: "removed"; left: T; leftIndex: number }
    | { type: "added"; right: T; rightIndex: number }
  > = [];

  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (equals(left[leftIndex]!, right[rightIndex]!)) {
      result.push({
        type: "same",
        left: left[leftIndex]!,
        right: right[rightIndex]!,
        leftIndex,
        rightIndex,
      });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    if (dp[leftIndex + 1]![rightIndex]! >= dp[leftIndex]![rightIndex + 1]!) {
      result.push({ type: "removed", left: left[leftIndex]!, leftIndex });
      leftIndex += 1;
    } else {
      result.push({ type: "added", right: right[rightIndex]!, rightIndex });
      rightIndex += 1;
    }
  }

  while (leftIndex < left.length) {
    result.push({ type: "removed", left: left[leftIndex]!, leftIndex });
    leftIndex += 1;
  }

  while (rightIndex < right.length) {
    result.push({ type: "added", right: right[rightIndex]!, rightIndex });
    rightIndex += 1;
  }

  return result;
}

function buildInlineSegments(leftValue: string, rightValue: string) {
  const tokenDiff = buildSequenceDiff(
    tokenizeInline(leftValue),
    tokenizeInline(rightValue),
    (leftToken, rightToken) => leftToken === rightToken,
  );
  const removed: DiffSegment[] = [];
  const added: DiffSegment[] = [];

  for (const entry of tokenDiff) {
    if (entry.type === "same") {
      removed.push({ type: "same", text: entry.left });
      added.push({ type: "same", text: entry.right });
    } else if (entry.type === "removed") {
      removed.push({ type: "removed", text: entry.left });
    } else {
      added.push({ type: "added", text: entry.right });
    }
  }

  return { removed, added };
}

function buildSideBySideRows(leftContent: string, rightContent: string): SideBySideRow[] {
  const left = normalizeLines(leftContent);
  const right = normalizeLines(rightContent);
  const lineDiff = buildSequenceDiff(left, right, (leftLine, rightLine) => leftLine === rightLine);
  const rows: SideBySideRow[] = [];
  let removedRows: Array<{ text: string; leftNumber: number }> = [];
  let addedRows: Array<{ text: string; rightNumber: number }> = [];

  function flushChangedRows() {
    const pairCount = Math.min(removedRows.length, addedRows.length);
    for (let index = 0; index < pairCount; index += 1) {
      const removedRow = removedRows[index]!;
      const addedRow = addedRows[index]!;
      const segments = buildInlineSegments(removedRow.text, addedRow.text);
      rows.push({
        leftNumber: removedRow.leftNumber,
        rightNumber: addedRow.rightNumber,
        leftText: removedRow.text,
        rightText: addedRow.text,
        leftType: "removed",
        rightType: "added",
        leftSegments: segments.removed,
        rightSegments: segments.added,
      });
    }
    for (const removedRow of removedRows.slice(pairCount)) {
      rows.push({
        leftNumber: removedRow.leftNumber,
        rightNumber: null,
        leftText: removedRow.text,
        rightText: "",
        leftType: "removed",
        rightType: "same",
      });
    }
    for (const addedRow of addedRows.slice(pairCount)) {
      rows.push({
        leftNumber: null,
        rightNumber: addedRow.rightNumber,
        leftText: "",
        rightText: addedRow.text,
        leftType: "same",
        rightType: "added",
      });
    }
    removedRows = [];
    addedRows = [];
  }

  for (const entry of lineDiff) {
    if (entry.type === "same") {
      if (removedRows.length > 0 || addedRows.length > 0) {
        flushChangedRows();
      }
      rows.push({
        leftNumber: entry.leftIndex + 1,
        rightNumber: entry.rightIndex + 1,
        leftText: entry.left,
        rightText: entry.right,
        leftType: "same",
        rightType: "same",
      });
    } else if (entry.type === "removed") {
      removedRows.push({ text: entry.left, leftNumber: entry.leftIndex + 1 });
    } else {
      addedRows.push({ text: entry.right, rightNumber: entry.rightIndex + 1 });
    }
  }

  if (removedRows.length > 0 || addedRows.length > 0) {
    flushChangedRows();
  }

  return rows;
}

function parseUnifiedPatch(patch: string): UnifiedRow[] {
  if (!patch || patch === "No textual differences.") {
    return [];
  }

  const rows: UnifiedRow[] = [];
  let leftLine = 0;
  let rightLine = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("index ")) {
      rows.push({ kind: "meta", marker: "", text: line, leftNumber: null, rightNumber: null });
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      rows.push({
        kind: "meta",
        marker: line.slice(0, 3),
        text: line.slice(4),
        leftNumber: null,
        rightNumber: null,
      });
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      leftLine = match ? Number(match[1]) : 0;
      rightLine = match ? Number(match[2]) : 0;
      rows.push({ kind: "hunk", marker: "@@", text: line, leftNumber: null, rightNumber: null });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({
        kind: "added",
        marker: "+",
        text: line.slice(1),
        leftNumber: null,
        rightNumber: rightLine,
      });
      rightLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({
        kind: "removed",
        marker: "-",
        text: line.slice(1),
        leftNumber: leftLine,
        rightNumber: null,
      });
      leftLine += 1;
      continue;
    }
    rows.push({
      kind: "context",
      marker: " ",
      text: line.startsWith(" ") ? line.slice(1) : line,
      leftNumber: leftLine,
      rightNumber: rightLine,
    });
    leftLine += 1;
    rightLine += 1;
  }

  return rows;
}
</script>

<template>
  <div v-if="filePath" class="docs-diff-page">
    <header class="docs-diff-header">
      <div>
        <p class="docs-diff-kicker">Version Compare</p>
        <h1 class="docs-diff-title">{{ pageTitle }}</h1>
        <p class="docs-diff-path">{{ filePath }}</p>
      </div>
      <div class="docs-diff-controls">
        <div class="docs-toolbar-group">
          <span>Base</span>
          <div class="docs-static-pill">{{ leftVersion }}</div>
        </div>
        <div class="docs-toolbar-group">
          <span>Target</span>
          <div class="docs-static-pill">{{ rightVersion }}</div>
        </div>
        <div class="docs-toolbar-group docs-toolbar-group--modes">
          <span>View</span>
          <div class="docs-mode-switch" role="tablist" aria-label="Diff view">
            <button
              :class="{ active: diffMode === 'unified' }"
              type="button"
              role="tab"
              :aria-selected="diffMode === 'unified'"
              @click="diffMode = 'unified'"
            >
              Unified
            </button>
            <button
              :class="{ active: diffMode === 'split' }"
              type="button"
              role="tab"
              :aria-selected="diffMode === 'split'"
              @click="diffMode = 'split'"
            >
              Split
            </button>
          </div>
        </div>
      </div>
    </header>

    <section class="docs-panel">
      <div class="docs-header">
        <div class="docs-eyebrow">{{ leftVersion }} -> {{ rightVersion }}</div>
      </div>

      <div v-if="diffMode === 'unified'" class="docs-unified">
        <div
          v-for="(row, index) in visibleUnifiedRows"
          :key="`${row.kind}-${index}`"
          class="docs-unified-row"
          :class="row.kind"
        >
          <div class="docs-unified-gutter">
            <span>{{ row.leftNumber ?? "" }}</span>
            <span>{{ row.rightNumber ?? "" }}</span>
          </div>
          <div class="docs-unified-marker">{{ row.marker }}</div>
          <pre class="docs-unified-code"><code><span
            v-for="(token, tokenIndex) in tokenizeSyntax(row.text)"
            :key="`${token.cls ?? 'plain'}-${tokenIndex}-${token.text}`"
            :class="token.cls ?? ''"
          >{{ token.text }}</span></code></pre>
        </div>
      </div>

      <div v-else class="docs-side-by-side">
        <div class="docs-side-header">
          <div class="docs-side-title">{{ leftVersion }}</div>
          <div class="docs-side-title">{{ rightVersion }}</div>
        </div>
        <div
          v-for="(row, index) in sideBySideRows"
          :key="`${row.leftNumber ?? 'l'}-${row.rightNumber ?? 'r'}-${index}`"
          class="docs-side-row"
        >
          <div class="docs-side-cell" :class="row.leftType">
            <div class="docs-side-gutter">
              <span>{{ row.leftNumber ?? "" }}</span>
            </div>
            <div class="docs-side-code">
              <span
                v-for="(segment, segmentIndex) in row.leftSegments ?? [{ type: 'same', text: row.leftText }]"
                :key="`${segment.type}-${segmentIndex}-${segment.text}`"
                :class="segment.type === 'same' ? '' : `docs-diff-token ${segment.type}`"
              ><span
                v-for="(token, tokenIndex) in tokenizeSyntax(segment.text)"
                :key="`${token.cls ?? 'plain'}-${tokenIndex}-${token.text}`"
                :class="token.cls ?? ''"
              >{{ token.text }}</span></span>
            </div>
          </div>
          <div class="docs-side-cell" :class="row.rightType">
            <div class="docs-side-gutter">
              <span>{{ row.rightNumber ?? "" }}</span>
            </div>
            <div class="docs-side-code">
              <span
                v-for="(segment, segmentIndex) in row.rightSegments ?? [{ type: 'same', text: row.rightText }]"
                :key="`${segment.type}-${segmentIndex}-${segment.text}`"
                :class="segment.type === 'same' ? '' : `docs-diff-token ${segment.type}`"
              ><span
                v-for="(token, tokenIndex) in tokenizeSyntax(segment.text)"
                :key="`${token.cls ?? 'plain'}-${tokenIndex}-${token.text}`"
                :class="token.cls ?? ''"
              >{{ token.text }}</span></span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
