import DefaultTheme from "vitepress/theme";
import { onContentUpdated } from "vitepress";
import type { Theme } from "vitepress";
import "./styles.css";

let mermaidLoadPromise: Promise<typeof import("mermaid")> | null = null;
let mermaidInitialized = false;

function loadMermaid() {
  mermaidLoadPromise ??= import("mermaid");
  return mermaidLoadPromise;
}

async function renderMermaidDiagrams(): Promise<void> {
  const { default: mermaid } = await loadMermaid();
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
    });
    mermaidInitialized = true;
  }
  await mermaid.run({
    querySelector: ".vp-doc .mermaid",
  });
}

const theme: Theme = {
  ...DefaultTheme,
  enhanceApp(ctx) {
    DefaultTheme.enhanceApp?.(ctx);
    if (typeof window === "undefined") {
      return;
    }
    onContentUpdated(() => {
      void renderMermaidDiagrams().catch((error) => {
        console.error("Mermaid render failed", error);
      });
    });
  },
};

export default theme;
