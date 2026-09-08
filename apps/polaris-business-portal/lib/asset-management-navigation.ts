export type WorkspaceType = "unclassified" | "ecommerce" | "research";

export type AssetManagementView =
  | "order-management"
  | "product-gallery"
  | "product-library"
  | "product-video"
  | "seo-ops"
  | "literature-review"
  | "submission-management";

export type AssetManagementHeader = {
  label: string;
  title: string;
};

export type AssetManagementNavItem = {
  label: string;
  view: AssetManagementView | null;
};

export type AssetManagementNavigationModel = {
  sectionLabel: string | null;
  sectionItems: AssetManagementNavItem[];
  searchEnabled: boolean;
  extraItems: AssetManagementNavItem[];
};

const ASSET_MANAGEMENT_TITLES: Record<AssetManagementView, string> = {
  "order-management": "订单管理",
  "product-gallery": "产品图册",
  "product-library": "产品管理",
  "product-video": "产品视频",
  "seo-ops": "SEO 运营",
  "literature-review": "文献综述",
  "submission-management": "投稿管理",
};

const ASSET_MANAGEMENT_HEADERS: Record<AssetManagementView, AssetManagementHeader> = {
  "order-management": { label: "订单管理", title: "订单管理" },
  "product-gallery": { label: "产品管理", title: "产品图册" },
  "product-library": { label: "产品管理", title: "产品管理" },
  "product-video": { label: "产品管理", title: "产品视频" },
  "seo-ops": { label: "SEO 运营", title: "SEO 运营" },
  "literature-review": { label: "文献综述", title: "文献综述" },
  "submission-management": { label: "投稿管理", title: "投稿管理" },
};

const ECOMMERCE_NAVIGATION: AssetManagementNavigationModel = {
  sectionLabel: null,
  sectionItems: [],
  searchEnabled: false,
  extraItems: [
    { label: "产品管理", view: "product-library" },
    { label: "订单管理", view: "order-management" },
    { label: "市场调研", view: null },
  ],
};

const RESEARCH_NAVIGATION: AssetManagementNavigationModel = {
  sectionLabel: null,
  sectionItems: [],
  searchEnabled: false,
  extraItems: [
    { label: "文献综述", view: "literature-review" },
    { label: "投稿管理", view: "submission-management" },
  ],
};

export function isAssetManagementView(value: string | null): value is AssetManagementView {
  return value === "order-management"
    || value === "product-gallery"
    || value === "product-library"
    || value === "product-video"
    || value === "seo-ops"
    || value === "literature-review"
    || value === "submission-management";
}

export function assetManagementTitle(view: AssetManagementView): string {
  return ASSET_MANAGEMENT_TITLES[view];
}

export function assetManagementHeader(view: AssetManagementView): AssetManagementHeader {
  return ASSET_MANAGEMENT_HEADERS[view];
}

export function resolveAssetManagementNavigation(
  workspaceType: WorkspaceType | null,
): AssetManagementNavigationModel {
  if (workspaceType === "research") return RESEARCH_NAVIGATION;
  return ECOMMERCE_NAVIGATION;
}
