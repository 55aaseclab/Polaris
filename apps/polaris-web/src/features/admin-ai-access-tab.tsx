import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PortalAiAccessActionKind, PortalAiAccessView } from "@/lib/api";
import {
  aiAccessActionLabel,
  aiAccessReferralLabel,
  aiAccessStateLabel,
  buildAdminAiAccessPanelModel,
  formatAiAccessBalance,
} from "@/lib/admin-ai-access";

type Props = {
  t: (key: string) => string;
  view: PortalAiAccessView | null;
  error: string | null;
  loading: boolean;
  actionInFlight: PortalAiAccessActionKind | null;
  onRunAction: (action: PortalAiAccessActionKind) => void;
};

export default function AdminAiAccessTab(props: Props) {
  const { t, view, error, loading, actionInFlight, onRunAction } = props;

  if (loading && !view) {
    return (
      <Card className="border-border/70">
        <CardHeader>
          <CardTitle className="text-base">{t("admin_user_tab_ai_access")}</CardTitle>
          <CardDescription>{t("ai_access_description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </CardContent>
      </Card>
    );
  }

  if (error && !view) {
    return (
      <Card className="border-border/70">
        <CardHeader>
          <CardTitle className="text-base">{t("admin_user_tab_ai_access")}</CardTitle>
          <CardDescription>{t("ai_access_description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!view) {
    return null;
  }

  const panel = buildAdminAiAccessPanelModel(view, t);

  return (
    <Card className="border-border/70">
      <CardHeader>
        <CardTitle className="text-base">{t("admin_user_tab_ai_access")}</CardTitle>
        <CardDescription>{t("ai_access_description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {panel.summaryCards.map((card) => (
            <div
              key={card.id}
              className="rounded-2xl border border-border/70 bg-muted/20 p-4"
            >
              <div className="text-xs text-muted-foreground">{card.label}</div>
              <div className="mt-1 text-lg font-semibold">{card.value}</div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
          <div className="grid gap-2">
            <div className="text-sm font-medium">{view.mainAction.headline}</div>
            <p className="text-sm text-muted-foreground">{view.mainAction.description}</p>
            {view.mainAction.stateReason ? (
              <p className="text-xs text-muted-foreground">{view.mainAction.stateReason}</p>
            ) : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={
                !view.mainAction.primaryAction.enabled
                || actionInFlight !== null
              }
              onClick={() => onRunAction(view.mainAction.primaryAction.kind)}
            >
              {actionInFlight === view.mainAction.primaryAction.kind
                ? t("working")
                : panel.primaryActionLabel}
            </Button>
            {view.mainAction.secondaryAction ? (
              <Button
                variant="outline"
                disabled={
                  !view.mainAction.secondaryAction.enabled
                  || actionInFlight !== null
                }
                onClick={() => onRunAction(view.mainAction.secondaryAction!.kind)}
              >
                {actionInFlight === view.mainAction.secondaryAction.kind
                  ? t("working")
                  : panel.secondaryActionLabel}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
            <div className="text-sm font-medium">{t("ai_access_balance_billing")}</div>
            <div className="mt-3 grid gap-2 text-sm">
              <div>
                <span className="text-muted-foreground">{t("ai_access_summary_mode")}:</span>{" "}
                {view.billing.billingMode.toUpperCase()}
              </div>
              <div>
                <span className="text-muted-foreground">{t("ai_access_summary_balance")}:</span>{" "}
                {formatAiAccessBalance(
                  view.billing.balanceAmount,
                  view.billing.balanceUnit,
                  t,
                )}
              </div>
              <div>
                <span className="text-muted-foreground">{t("ai_access_last_topup")}:</span>{" "}
                {view.billing.lastTopupAt ?? t("none")}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
            <div className="text-sm font-medium">{t("ai_access_referral")}</div>
            <div className="mt-3 grid gap-2 text-sm">
              <div>
                <span className="text-muted-foreground">{t("ai_access_summary_referral")}:</span>{" "}
                {aiAccessReferralLabel(view.summary.referralState, t)}
              </div>
              <div>
                <span className="text-muted-foreground">{t("ai_access_invite_code")}:</span>{" "}
                {view.referral.inviteCode ?? t("none")}
              </div>
              <div className="break-all">
                <span className="text-muted-foreground">{t("ai_access_invite_link")}:</span>{" "}
                {view.referral.inviteLink ?? t("none")}
              </div>
              <div>
                <span className="text-muted-foreground">{t("ai_access_rebate_summary")}:</span>{" "}
                {view.referral.rebateSummary ?? t("none")}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
          <div className="text-sm font-medium">{t("ai_access_status")}</div>
          <div className="mt-3 grid gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">{t("ai_access_access_state")}:</span>{" "}
              {aiAccessStateLabel(view.state, t)}
            </div>
            <div>
              <span className="text-muted-foreground">{t("ai_access_account_linked")}:</span>{" "}
              {view.accessStatus.accountLinked ? t("yes") : t("no")}
            </div>
            <div>
              <span className="text-muted-foreground">{t("ai_access_runtime_ready")}:</span>{" "}
              {view.accessStatus.runtimeReady ? t("yes") : t("no")}
            </div>
            <div>
              <span className="text-muted-foreground">{t("ai_access_last_sync")}:</span>{" "}
              {view.accessStatus.lastSyncAt ?? t("none")}
            </div>
            {view.accessStatus.statusMessage ? (
              <div>
                <span className="text-muted-foreground">{t("ai_access_status_message")}:</span>{" "}
                {view.accessStatus.statusMessage}
              </div>
            ) : null}
          </div>
        </div>

        {panel.showAdvanced ? (
          <details className="rounded-2xl border border-border/70 bg-background">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              {t("ai_access_advanced")}
            </summary>
            <div className="grid gap-2 border-t border-border/70 px-4 py-3 text-sm">
              <div>
                <span className="text-muted-foreground">{t("ai_access_provider_backend")}:</span>{" "}
                {view.advanced.providerBackend}
              </div>
              <div>
                <span className="text-muted-foreground">{t("ai_access_provider_account")}:</span>{" "}
                {view.advanced.providerAccountId ?? t("none")}
              </div>
              <div>
                <span className="text-muted-foreground">{t("ai_access_provider_token")}:</span>{" "}
                {view.advanced.providerTokenPresent ? t("present") : t("none")}
              </div>
              <div>
                <span className="text-muted-foreground">{t("ai_access_credential_sync")}:</span>{" "}
                {view.advanced.credentialSyncStatus}
              </div>
              <div>
                <span className="text-muted-foreground">{t("ai_access_default_credential")}:</span>{" "}
                {view.advanced.defaultCredentialId ?? t("none")}
              </div>
              <div>
                <span className="text-muted-foreground">{t("ai_access_last_sync")}:</span>{" "}
                {view.advanced.lastInternalSyncAt ?? t("none")}
              </div>
              {view.advanced.lastErrorMessage ? (
                <div>
                  <span className="text-muted-foreground">{t("ai_access_last_error")}:</span>{" "}
                  {view.advanced.lastErrorMessage}
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
