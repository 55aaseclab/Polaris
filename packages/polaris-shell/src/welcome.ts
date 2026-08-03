import type { ShellSession } from "./api.js";

export type WelcomeAction =
  | "auto-sign-in"
  | "ensure-user-and-hosts"
  | "navigate-hosts";

export function resolveWelcomeAction(input: {
  authMode: ShellSession["authMode"];
  session: Pick<ShellSession, "authenticated" | "polarisUserId"> | null;
}): WelcomeAction {
  if (input.session?.authenticated) {
    return input.session.polarisUserId
      ? "navigate-hosts"
      : "ensure-user-and-hosts";
  }

  return input.authMode === "disabled"
    ? "navigate-hosts"
    : "auto-sign-in";
}
