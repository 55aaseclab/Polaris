import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  referredByCode?: string | null;
  error: string | null;
  loading: boolean;
  actionInFlight: PortalAiAccessActionKind | null;
  onRunAction: (action: PortalAiAccessActionKind) => void;
};

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the legacy copy path for non-secure contexts.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("legacy-copy-failed");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

export default function AdminAiAccessTab(props: Props) {
  const {
    t,
    view,
    referredByCode,
    error,
    loading,
    actionInFlight,
    onRunAction,
  } = props;
  const [copyFeedback, setCopyFeedback] = React.useState<{
    title: string;
    message: string;
  } | null>(null);
  const sectionClassName = "grid gap-3 border-b border-border/60 pb-6 last:border-b-0 last:pb-0";

  React.useEffect(() => {
    setCopyFeedback(null);
  }, [view?.referral.inviteLink]);

  if (loading && !view) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      </div>
    );
  }

  if (error && !view) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-destructive">{error}</p>
      </div>
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
      await copyText(view.referral.inviteLink);
      setCopyFeedback({
        title: t("ai_access_copy_success_title"),
        message: t("ai_access_copy_success_hint"),
      });
    } catch {
      setCopyFeedback({
        title: t("ai_access_copy_failed_title"),
        message: t("ai_access_copy_failed"),
      });
    }
  }

  return (
    <>
      <AlertDialog
        open={copyFeedback !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCopyFeedback(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copyFeedback?.title}</AlertDialogTitle>
            <AlertDialogDescription>{copyFeedback?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setCopyFeedback(null)}>
              {t("ok")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="grid gap-6">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className={sectionClassName}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("ai_access_status")}</div>
            </div>
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
              {!primaryActionInBilling ? (
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

        <div className={sectionClassName}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("ai_access_balance_billing")}</div>
            </div>
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
          <div className="grid gap-2 text-sm">
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

        <div className={sectionClassName}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("ai_access_referral")}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!view.referral.inviteLink}
              onClick={() => {
                void handleCopyReferralLink();
              }}
            >
              {t("ai_access_copy_link")}
            </Button>
          </div>
          <div className="grid gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">{t("ai_access_summary_referral")}:</span>{" "}
              {aiAccessReferralLabel(view.summary.referralState, t)}
            </div>
            <div>
              <span className="text-muted-foreground">{t("ai_access_polaris_referral_code")}:</span>{" "}
              {referredByCode ?? t("none")}
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
    </>
  );
}
