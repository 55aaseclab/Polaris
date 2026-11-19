function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderWanghaiEmbedPage(input: {
  hostName: string;
  portalUrl: string;
  backHref?: string;
}): string {
  const hostName = input.hostName.trim();
  const portalUrl = input.portalUrl.trim();
  const backHref = input.backHref?.trim() || "/hosts";
  if (!hostName || !portalUrl) {
    throw new Error("hostName and portalUrl are required");
  }
  return `<section class="portal-shell">
    <a class="button secondary portal-shell-back" href="${escapeHtml(backHref)}" data-nav aria-label="返回主机">返回</a>
    <iframe class="portal-shell-frame" title="${escapeHtml(hostName)} 行业门户" src="${escapeHtml(portalUrl)}"></iframe>
  </section>`;
}
