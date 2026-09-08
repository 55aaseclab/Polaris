export function shouldSyncAssetSidebarToAssets(
  previousView: string | null,
  nextView: string | null,
): boolean {
  return nextView !== null && previousView !== nextView;
}
