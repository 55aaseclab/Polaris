import type { CatalogInput, ContentProductionInput } from "./types.js";
import { ContentProductionError } from "./types.js";

/** Project umbrella content-production input → internal catalog-input. */
export function contentInputToCatalogInput(input: ContentProductionInput): CatalogInput {
  if (input.content_kind !== "product-catalog") {
    throw new ContentProductionError(
      `content_kind=${input.content_kind} is not implemented in this tool yet (only product-catalog)`,
      2,
    );
  }
  const cfg = input.kind_config.product_catalog;
  if (!cfg) {
    throw new ContentProductionError(
      "kind_config.product_catalog is required when content_kind=product-catalog",
      2,
    );
  }

  return {
    schema: "wanghai.promo.catalog-input",
    schema_version: 1,
    catalog_id: input.job_id,
    title: input.title,
    subtitle: input.subtitle ?? null,
    locale: input.locale,
    market: input.market,
    template_id: cfg.template_id,
    page_size: cfg.page_size,
    orientation: cfg.orientation,
    selection: {
      mode: input.product_selection.mode,
      product_ids: [...input.product_selection.product_ids],
      batch: input.product_selection.batch,
      filters: input.product_selection.filters,
    },
    price_policy: { ...cfg.price_policy },
    include_sections: { ...cfg.include_sections },
    brand: {
      name: input.brand.name,
      tagline: input.brand.tagline,
      logo_path: input.brand.logo_path,
      contact_lines: [...input.brand.contact_lines],
    },
    options: {
      require_ready: input.pipeline.require_ready,
      require_include_in_external: input.pipeline.require_include_in_external,
      require_images: [...cfg.options.require_images],
      max_selling_points: cfg.options.max_selling_points,
      image_slots_on_page: [...cfg.options.image_slots_on_page],
    },
    notes: [...input.notes],
  };
}

export function defaultContentInput(partial: {
  job_id: string;
  title?: string;
  product_ids?: number[];
  batch?: string | null;
  mode?: CatalogInput["selection"]["mode"];
  locale?: CatalogInput["locale"];
  market?: string;
  brand_name?: string;
  contact_lines?: string[];
  skip_package?: boolean;
  strict?: boolean;
}): ContentProductionInput {
  const mode =
    partial.mode ??
    (partial.batch && !partial.product_ids?.length ? "batch" : "explicit");
  return {
    schema_version: "wanghai.content-production.input.v1",
    job_id: partial.job_id,
    content_kind: "product-catalog",
    title: partial.title ?? partial.job_id,
    subtitle: null,
    locale: partial.locale ?? "en",
    market: partial.market ?? "CN",
    product_selection: {
      mode,
      product_ids: partial.product_ids ?? [],
      batch: partial.batch ?? null,
      filters: null,
    },
    brand: {
      name: partial.brand_name ?? "Demo Brand",
      tagline: null,
      logo_path: null,
      contact_lines: partial.contact_lines ?? ["sales@example.com"],
    },
    pipeline: {
      phases: [
        "validate",
        "select",
        "freeze",
        "plan",
        "produce",
        "package",
        "review",
        "publish",
      ],
      require_ready: true,
      require_include_in_external: true,
      review_mode: "auto-pass",
      skip_package: partial.skip_package ?? false,
      strict: partial.strict ?? false,
    },
    kind_config: {
      product_catalog: {
        template_id: "single-product-page.v1",
        page_size: "A4",
        orientation: "portrait",
        price_policy: {
          mode: "list_price",
          show_currency: true,
          hide_if_null: true,
          label: "List price",
        },
        include_sections: {
          cover: true,
          toc: false,
          brand_intro: false,
          product_pages: true,
          packaging: false,
          contact: true,
        },
        options: {
          require_images: ["near"],
          max_selling_points: 5,
          image_slots_on_page: ["near", "wear", "detail"],
        },
        catalog_input_ref: null,
      },
      carousel: null,
      video: null,
    },
    notes: [],
  };
}

/** Detect whether a document is umbrella content-production input. */
export function isContentProductionInput(data: unknown): data is ContentProductionInput {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { schema_version?: string }).schema_version ===
      "wanghai.content-production.input.v1"
  );
}

/** Detect legacy catalog-only input. */
export function isCatalogInput(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    ((data as { schema?: string }).schema === "wanghai.promo.catalog-input" ||
      (typeof (data as { catalog_id?: unknown }).catalog_id === "string" &&
        (data as { schema_version?: unknown }).schema_version === 1 &&
        (data as { template_id?: unknown }).template_id !== undefined))
  );
}
