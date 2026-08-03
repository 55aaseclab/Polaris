export const AUTHING_LOGIN_ERROR_MESSAGE = "登录状态无效，请重新登录";

export function normalizeAuthingLoginErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "");
  if (
    message === "Invalid Authing session"
    || message === "Authing 登录状态无效，请重新登录"
    || message === "Authing 登录未完成"
    || message === "登录会话不可用"
    || message === "Authing user info request failed"
    || message === "Authing user info could not be reached"
  ) {
    return AUTHING_LOGIN_ERROR_MESSAGE;
  }
  return message || AUTHING_LOGIN_ERROR_MESSAGE;
}
