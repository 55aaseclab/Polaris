import * as React from "react";
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
  aiAccessStateReason,
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
  const [copiedReferralLink, setCopiedReferralLink] = React.useState(false);

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
  const primaryActionInBilling = view.mainAction.primaryAction.kind === "top_up";
  const secondaryActionInBilling = view.mainAction.secondaryAction?.kind === "top_up";

  async function handleCopyReferralLink(): Promise<void> {
    if (!view?.referral.inviteLink) {
      return;
    }
    try {
      await navigator.clipboard.writeText(view.referral.inviteLink);
      setCopiedReferralLink(true);
      window.setTimeout(() => setCopiedReferralLink(false), 1500);
    } catch {
      setCopiedReferralLink(false);
    }
  }

  return (
    <Card className="border-border/70">
      <CardHeader>
        <CardTitle className="text-base">{t("admin_user_tab_ai_access")}</CardTitle>
        <CardDescription>{t("ai_access_description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
          <div className="grid gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm font-medium">{t("ai_access_status")}</div>
              <div className="flex flex-wrap justify-end gap-2">
                {view.mainAction.secondaryAction && !secondaryActionInBilling ? (
                  <Button
                    size="sm"
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
            <div className="grid gap-2 text-sm">
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
            </div>
            {view.accessStatus.statusMessage ? (
              <p className="text-xs text-muted-foreground">
                {t("ai_access_status_message")}: {view.accessStatus.statusMessage}
              </p>
            ) : null}
            {aiAccessStateReason(view.state, t) ? (
              <p className="text-xs text-muted-foreground">{aiAccessStateReason(view.state, t)}</p>
            ) : null}
          </div>
          {!primaryActionInBilling ? (
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
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm font-medium">{t("ai_access_balance_billing")}</div>
              <div className="flex flex-wrap justify-end gap-2">
                {primaryActionInBilling ? (
                  <Button
                    size="sm"
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
                ) : null}
                {view.mainAction.secondaryAction && secondaryActionInBilling ? (
                  <Button
                    size="sm"
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
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm font-medium">{t("ai_access_referral")}</div>
              <Button
                size="sm"
                variant="outline"
                disabled={!view.referral.inviteLink}
                onClick={() => {
                  void handleCopyReferralLink();
                }}
              >
                {copiedReferralLink ? t("ai_access_copied") : t("ai_access_copy_link")}
              </Button>
            </div>
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
            </div>
          </div>
        </div>

      </CardContent>
    </Card>
  );
}
