import type { JsonObject } from "@polaris/business-core";

export type Locale = "zh" | "en";
export type ImageSlot = "near" | "wear" | "detail";
export type PriceMode = "list_price" | "promo_price" | "hide" | "inquiry";
export type SelectionMode = "explicit" | "batch" | "external";

export type CatalogInput = {
  schema: "wanghai.promo.catalog-input";
  schema_version: 1;
  catalog_id: string;
  title: string;
  subtitle: string | null;
  locale: Locale;
  market: string;
  template_id: "single-product-page.v1";
  page_size: "A4";
  orientation: "portrait";
  selection: {
    mode: SelectionMode;
    product_ids: number[];
    batch: string | null;
    filters: JsonObject | null;
  };
  price_policy: {
    mode: PriceMode;
    show_currency: boolean;
    hide_if_null: boolean;
    label: string | null;
  };
  include_sections: {
    cover: boolean;
    toc: boolean;
    brand_intro: boolean;
    product_pages: boolean;
    packaging: boolean;
    contact: boolean;
  };
  brand: {
    name: string;
    tagline: string | null;
    logo_path: string | null;
    contact_lines: string[];
  };
  options: {
    require_ready: boolean;
    require_include_in_external: boolean;
    require_images: ImageSlot[];
    max_selling_points: number;
    image_slots_on_page: ImageSlot[];
  };
  notes: string[];
};

export type ImageRef = {
  path: string;
  sha256: string;
} | null;

export type SnapshotPage = {
  kind: "product";
  product_id: number;
  slug: string;
  batch: string;
  display_name: string;
  name_en: string | null;
  category: string | null;
  copy: {
    title: string | null;
    selling_points: string[];
    description: string | null;
  };
  specs: {
    dimensions_mm: {
      length: number | null;
      width: number | null;
      height: number | null;
    };
    weight_with_packaging_kg: number | null;
    packaging_mode: "normal" | "gift";
  };
  images: Record<ImageSlot, ImageRef>;
  price: {
    currency: string | null;
    amount: number | null;
    display: string | null;
    policy: string;
  };
  source_meta_sha256: string;
};

export type SkippedProduct = {
  product_id: number | null;
  reason: string;
  detail?: string | null;
};

export type CatalogSnapshot = {
  schema: "wanghai.promo.catalog-snapshot";
  schema_version: 1;
  catalog_id: string;
  frozen_at: string;
  from_input_sha256: string;
  template_id: string;
  locale: Locale;
  market: string;
  page_size: string;
  orientation: string;
  cover: {
    title: string;
    subtitle: string | null;
  };
  brand: CatalogInput["brand"];
  include_sections: CatalogInput["include_sections"];
  price_policy: CatalogInput["price_policy"];
  pages: SnapshotPage[];
  skipped: SkippedProduct[];
};

export type CatalogOutput = {
  schema: "wanghai.promo.catalog-output";
  schema_version: 1;
  catalog_id: string;
  status: "published";
  generated_at: string;
  input_sha256: string;
  snapshot_sha256: string;
  template_id: string;
  locale: Locale;
  market: string;
  counts: {
    requested: number;
    included: number;
    skipped: number;
  };
  products: Array<{
    product_id: number;
    slug: string;
    batch: string;
    name: string;
    page_index: number;
    images_used: Record<ImageSlot, string | null>;
    price_shown: {
      currency: string | null;
      amount: number | null;
      policy: string;
    };
    source_meta_sha256: string;
  }>;
  skipped: SkippedProduct[];
  artifacts: {
    html: string;
    pdf: string;
    snapshot: string;
    manifest: string;
  };
  warnings: string[];
};

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

/** Public alias — catalog is one kind of content production. */
export class ContentProductionError extends CatalogError {
  constructor(message: string, exitCode: number = 1) {
    super(message, exitCode);
    this.name = "ContentProductionError";
  }
}

export type ContentKind = "product-catalog" | "carousel" | "video";

export type ContentProductionInput = {
  schema_version: "wanghai.content-production.input.v1";
  job_id: string;
  content_kind: ContentKind;
  title: string;
  subtitle?: string | null;
  locale: Locale;
  market: string;
  product_selection: CatalogInput["selection"];
  brand: CatalogInput["brand"];
  pipeline: {
    phases: string[];
    require_ready: boolean;
    require_include_in_external: boolean;
    review_mode: "auto-pass" | "manual-review";
    skip_package: boolean;
    strict: boolean;
  };
  kind_config: {
    product_catalog: null | {
      template_id: "single-product-page.v1";
      page_size: "A4";
      orientation: "portrait";
      price_policy: CatalogInput["price_policy"];
      include_sections: CatalogInput["include_sections"];
      options: {
        require_images: ImageSlot[];
        max_selling_points: number;
        image_slots_on_page: ImageSlot[];
      };
      catalog_input_ref?: string | null;
    };
    carousel: null | Record<string, unknown>;
    video: null | Record<string, unknown>;
  };
  notes: string[];
};

export type ContentProductionOutput = {
  schema_version: "wanghai.content-production.output.v1";
  job_id: string;
  content_kind: ContentKind;
  status: "draft" | "awaiting_review" | "published" | "partial" | "failed";
  generated_at: string;
  input_sha256: string;
  snapshot_sha256: string | null;
  locale: Locale;
  market: string;
  counts: {
    requested: number;
    included: number;
    skipped: number;
  };
  products_used: Array<{
    product_id: number;
    slug: string;
    batch: string;
    name: string;
    source_meta_sha256: string;
    role: string | null;
  }>;
  skipped: SkippedProduct[];
  phases: Array<{
    phase: string;
    status: "ok" | "skipped" | "failed" | "awaiting";
    started_at: string | null;
    finished_at: string | null;
    detail: string | null;
    artifact_paths: string[];
  }>;
  artifacts: {
    manifest: string;
    primary: string | null;
    preview: string | null;
    snapshot: string | null;
    plan: string | null;
    extras: string[];
  };
  kind_output: {
    product_catalog: null | {
      template_id: string;
      page_count: number;
      pdf: string | null;
      html: string | null;
      catalog_output_ref: string | null;
    };
    carousel: null;
    video: null;
  };
  warnings: string[];
};
