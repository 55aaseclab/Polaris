import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAuthingLoginErrorMessage, AUTHING_LOGIN_ERROR_MESSAGE } from "./auth-errors.js";

test("normalizes authing login errors to one message", () => {
  assert.equal(normalizeAuthingLoginErrorMessage("Invalid Authing session"), AUTHING_LOGIN_ERROR_MESSAGE);
  assert.equal(
    normalizeAuthingLoginErrorMessage("Authing 登录状态无效，请重新登录"),
    AUTHING_LOGIN_ERROR_MESSAGE,
  );
  assert.equal(normalizeAuthingLoginErrorMessage("Authing 登录未完成"), AUTHING_LOGIN_ERROR_MESSAGE);
  assert.equal(normalizeAuthingLoginErrorMessage("登录会话不可用"), AUTHING_LOGIN_ERROR_MESSAGE);
  assert.equal(
    normalizeAuthingLoginErrorMessage("Authing user info request failed"),
    AUTHING_LOGIN_ERROR_MESSAGE,
  );
  assert.equal(
    normalizeAuthingLoginErrorMessage("Authing user info could not be reached"),
    AUTHING_LOGIN_ERROR_MESSAGE,
  );
});
