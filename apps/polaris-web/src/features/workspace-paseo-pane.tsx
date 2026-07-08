import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

type Props = {
  t: (key: string) => string;
  liveTarget: string | null;
  refreshing: boolean;
  refreshDisabled: boolean;
  onRefreshStatus: () => void;
  liveCredentialControls: ReactNode;
  workspaceControlsCard: ReactNode;
  driverLabel: string;
  baseImage: string | null;
  rootdiskImage: string | null;
  runtimeKindLabel: string;
  runtimeRef: string | null;
  assetCountLabel: string;
  assetTable: ReactNode;
};

export default function WorkspacePaseoPane(props: Props) {
  return (
    <div className="flex min-h-[75dvh] w-full min-w-0 flex-col gap-6">
      <div className="grid gap-6">
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-base font-semibold">{props.t("paseo_info")}</div>
            <Button
              variant="outline"
              size="sm"
              onClick={props.onRefreshStatus}
              disabled={props.refreshDisabled}
            >
              {props.refreshing ? props.t("refreshing") : props.t("refresh")}
            </Button>
          </div>
          {props.liveTarget ? (
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">{props.t("live_target")}</div>
              </div>
              <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                <span className="break-all">{props.liveTarget}</span>
              </div>
            </div>
          ) : null}
          {props.liveCredentialControls}
        </div>
        <Separator />
        {props.workspaceControlsCard}
        <Separator />
        <div className="grid gap-4">
          <div className="text-base font-semibold">{props.t("driver_info")}</div>
          <div className="grid gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">{props.t("current_driver")}</div>
              </div>
              <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                {props.driverLabel}
              </div>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">{props.t("base_image")}</div>
              </div>
              <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                <span className="break-all">
                  {props.baseImage ?? props.t("unknown")}
                </span>
              </div>
            </div>
            {props.rootdiskImage ? (
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{props.t("rootdisk_image")}</div>
                  <div className="text-sm text-muted-foreground">{props.t("driver_info")}</div>
                </div>
                <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                  <span className="break-all">{props.rootdiskImage}</span>
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">{props.t("driver_runtime")}</div>
              </div>
              <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                <div>{props.runtimeKindLabel}</div>
                <div className="break-all">{props.runtimeRef ?? props.t("unknown")}</div>
              </div>
            </div>
          </div>
        </div>
        <Separator />
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-base font-semibold">{props.t("evolution_memory")}</div>
            <div className="text-sm text-muted-foreground">{props.assetCountLabel}</div>
          </div>
          {props.assetTable}
        </div>
        <Separator />
      </div>
    </div>
  );
}
