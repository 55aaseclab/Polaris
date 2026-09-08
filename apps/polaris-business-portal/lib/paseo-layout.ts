export function showLeftPaseoOverlay(
  sidebarTab: "assets" | "workflows" | "paseo",
  paseoInRightSidebar: boolean,
): boolean {
  return sidebarTab === "paseo" && !paseoInRightSidebar;
}
