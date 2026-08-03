import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTransientValue,
  readTransientValue,
  writeTransientValue,
} from "./transient-auth.js";

test("transient auth values fall back to cookies", () => {
  const sessionValues = new Map<string, string>();
  const localValues = new Map<string, string>();
  let cookieJar = "";

  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      removeItem: (key: string) => void sessionValues.delete(key),
      setItem: (key: string, value: string) => void sessionValues.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => localValues.get(key) ?? null,
      removeItem: (key: string) => void localValues.delete(key),
      setItem: (key: string, value: string) => void localValues.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie(): string {
        return cookieJar;
      },
      set cookie(value: string) {
        cookieJar = value;
      },
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:" },
  });

  writeTransientValue("polaris_authing_state", "state-123");
  sessionValues.clear();
  localValues.clear();

  assert.equal(readTransientValue("polaris_authing_state"), "state-123");

  clearTransientValue("polaris_authing_state");
  assert.equal(readTransientValue("polaris_authing_state"), null);
});
