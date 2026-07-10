import type {
  PortalAiAccessActionKind,
  PortalAiAccessState,
  PortalAiAccessView,
} from "./api";

export function aiAccessActionLabel(
  kind: PortalAiAccessActionKind,
  t: (key: string) => string,
): string {
  switch (kind) {
    case "provision_access":
      return t("ai_access_action_provision");
    case "top_up":
      return t("ai_access_action_top_up");
    case "refresh_status":
      return t("ai_access_action_refresh");
    case "retry":
      return t("ai_access_action_retry");
  }
}

export function aiAccessStateLabel(
  state: PortalAiAccessState,
  t: (key: string) => string,
): string {
  switch (state) {
    case "not_provisioned":
      return t("ai_access_state_not_provisioned");
    case "funding_needed":
      return t("ai_access_state_funding_needed");
    case "ready":
      return t("ai_access_state_ready");
    case "error":
      return t("ai_access_state_error");
  }
}

export function aiAccessReferralLabel(
  state: PortalAiAccessView["summary"]["referralState"],
  t: (key: string) => string,
): string {
  switch (state) {
    case "enabled":
      return t("ai_access_referral_enabled");
    case "disabled":
      return t("ai_access_referral_disabled");
    case "error":
      return t("ai_access_referral_error");
    case "unavailable":
      return t("ai_access_referral_unavailable");
  }
}

export function formatAiAccessBalance(
  amount: number | null,
  unit: string | null,
  t: (key: string) => string,
): string {
  if (typeof amount !== "number") {
    return t("unknown");
  }
  return unit ? `${amount} ${unit}` : String(amount);
}

export function buildAdminAiAccessPanelModel(
  view: PortalAiAccessView,
  t: (key: string) => string,
): {
  summaryCards: Array<{ id: string; label: string; value: string }>;
  primaryActionLabel: string;
  secondaryActionLabel: string | null;
  showAdvanced: boolean;
} {
  return {
    summaryCards: [
      {
        id: "access",
        label: t("ai_access_summary_access"),
        value: aiAccessStateLabel(view.summary.accessState, t),
      },
      {
        id: "mode",
        label: t("ai_access_summary_mode"),
        value: view.summary.billingMode.toUpperCase(),
      },
      {
        id: "balance",
        label: t("ai_access_summary_balance"),
        value: formatAiAccessBalance(
          view.summary.availableBalance,
          view.summary.balanceUnit,
          t,
        ),
      },
      {
        id: "referral",
        label: t("ai_access_summary_referral"),
        value: aiAccessReferralLabel(view.summary.referralState, t),
      },
    ],
    primaryActionLabel: aiAccessActionLabel(
      view.mainAction.primaryAction.kind,
      t,
    ),
    secondaryActionLabel: view.mainAction.secondaryAction
      ? aiAccessActionLabel(view.mainAction.secondaryAction.kind, t)
      : null,
    showAdvanced:
      Boolean(view.advanced.providerAccountId)
      || Boolean(view.advanced.defaultCredentialId)
      || Boolean(view.advanced.lastErrorMessage)
      || view.advanced.providerTokenPresent,
  };
}
