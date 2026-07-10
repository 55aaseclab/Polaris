import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAdminAiAccessPanelModel,
} from "../../polaris-web/src/lib/admin-ai-access";
import type { PortalAiAccessView } from "../../polaris-web/src/lib/api";

const translations: Record<string, string> = {
  ai_access_summary_access: "Access",
  ai_access_summary_mode: "Mode",
  ai_access_summary_balance: "Balance",
  ai_access_summary_referral: "Referral",
  ai_access_action_provision: "Provision Access",
  ai_access_action_top_up: "Top Up",
  ai_access_action_refresh: "Refresh",
  ai_access_action_retry: "Retry",
  ai_access_state_not_provisioned: "Not provisioned",
  ai_access_state_funding_needed: "Needs funding",
  ai_access_state_ready: "Ready",
  ai_access_state_error: "Error",
  ai_access_referral_enabled: "Enabled",
  ai_access_referral_disabled: "Disabled",
  ai_access_referral_error: "Error",
  ai_access_referral_unavailable: "Unavailable",
  unknown: "Unknown",
};

function t(key: string): string {
  return translations[key] ?? key;
}

function sampleView(overrides: Partial<PortalAiAccessView> = {}): PortalAiAccessView {
  return {
    state: "funding_needed",
    summary: {
      accessState: "funding_needed",
      billingMode: "payg",
      availableBalance: 0,
      balanceUnit: "credits",
      referralState: "enabled",
    },
    mainAction: {
      headline: "AI access needs funding",
      description: "Top up this user.",
      primaryAction: { kind: "top_up", enabled: true },
      secondaryAction: { kind: "refresh_status", enabled: true },
    },
    accessStatus: {
      provisioningStatus: "provisioned",
      accountLinked: true,
      runtimeReady: false,
      lastSyncAt: null,
      statusMessage: null,
    },
    billing: {
      billingMode: "payg",
      subscriptionStatus: "none",
      subscriptionName: null,
      balanceAmount: 0,
      balanceUnit: "credits",
      lastTopupAt: null,
    },
    referral: {
      referralEnabled: true,
      inviteCode: "ABCD-12",
      inviteLink: "https://ai-access.local/ref?code=ABCD-12",
      rebateSummary: "0 credits earned",
    },
    advanced: {
      providerBackend: "local",
      providerAccountId: "local-user",
      providerTokenPresent: true,
      credentialSyncStatus: "idle",
      defaultCredentialId: null,
      lastInternalSyncAt: null,
      lastErrorMessage: null,
    },
    capabilities: {
      provisionAccess: true,
      topUp: true,
      referral: true,
      subscription: false,
    },
    ...overrides,
  };
}

test("AI access panel model renders summary cards from the normalized view", () => {
  const model = buildAdminAiAccessPanelModel(sampleView(), t);
  assert.deepEqual(
    model.summaryCards.map((entry) => [entry.label, entry.value]),
    [
      ["Mode", "PAYG"],
      ["Balance", "0 credits"],
      ["Referral", "Enabled"],
    ],
  );
});

test("AI access panel model switches primary CTA labels by action kind", () => {
  const provisionModel = buildAdminAiAccessPanelModel(sampleView({
    state: "not_provisioned",
    summary: {
      accessState: "not_provisioned",
      billingMode: "payg",
      availableBalance: null,
      balanceUnit: "credits",
      referralState: "unavailable",
    },
    mainAction: {
      headline: "Not provisioned",
      description: "Provision first",
      primaryAction: { kind: "provision_access", enabled: true },
    },
  }), t);
  assert.equal(provisionModel.primaryActionLabel, "Provision Access");

  const retryModel = buildAdminAiAccessPanelModel(sampleView({
    state: "error",
    summary: {
      accessState: "error",
      billingMode: "payg",
      availableBalance: 25,
      balanceUnit: "credits",
      referralState: "error",
    },
    mainAction: {
      headline: "Needs attention",
      description: "Retry",
      primaryAction: { kind: "retry", enabled: true },
    },
  }), t);
  assert.equal(retryModel.primaryActionLabel, "Retry");
});

test("AI access panel model only shows advanced diagnostics when internal details exist", () => {
  const hiddenModel = buildAdminAiAccessPanelModel(sampleView({
    advanced: {
      providerBackend: "local",
      providerAccountId: null,
      providerTokenPresent: false,
      credentialSyncStatus: "idle",
      defaultCredentialId: null,
      lastInternalSyncAt: null,
      lastErrorMessage: null,
    },
  }), t);
  assert.equal(hiddenModel.showAdvanced, false);

  const visibleModel = buildAdminAiAccessPanelModel(sampleView({
    advanced: {
      providerBackend: "local",
      providerAccountId: "local-user",
      providerTokenPresent: false,
      credentialSyncStatus: "idle",
      defaultCredentialId: null,
      lastInternalSyncAt: null,
      lastErrorMessage: null,
    },
  }), t);
  assert.equal(visibleModel.showAdvanced, true);
});
