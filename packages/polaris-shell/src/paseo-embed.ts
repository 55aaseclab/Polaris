function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderPaseoEmbedPage(input: {
  hostName: string;
  paseoUrl: string;
  backHref?: string;
}): string {
  const hostName = input.hostName.trim();
  const paseoUrl = input.paseoUrl.trim();
  const backHref = input.backHref?.trim() || "/hosts";
  if (!hostName || !paseoUrl) {
    throw new Error("hostName and paseoUrl are required");
  }
  return `<section class="portal-shell">
    <a class="button secondary portal-shell-back" href="${escapeHtml(backHref)}" data-nav aria-label="返回主机">返回</a>
    <iframe class="portal-shell-frame" title="${escapeHtml(hostName)} coding 工作面" src="${escapeHtml(paseoUrl)}"></iframe>
  </section>`;
}
