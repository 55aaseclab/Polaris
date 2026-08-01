import assert from "node:assert/strict";
import test from "node:test";
import {
  clampFloatingButtonPosition,
  defaultFloatingButtonPosition,
  didFloatingButtonDrag,
} from "./floating-button.js";

test("defaultFloatingButtonPosition places the button at bottom left", () => {
  assert.deepEqual(
    defaultFloatingButtonPosition({
      viewportWidth: 1280,
      viewportHeight: 720,
      elementWidth: 80,
      elementHeight: 36,
      margin: 14,
    }),
    { x: 14, y: 670 },
  );
});

test("clampFloatingButtonPosition keeps the button inside the viewport", () => {
  assert.deepEqual(
    clampFloatingButtonPosition(
      { x: -20, y: 9999 },
      {
        viewportWidth: 400,
        viewportHeight: 300,
        elementWidth: 90,
        elementHeight: 40,
        margin: 12,
      },
    ),
    { x: 12, y: 248 },
  );
});

test("didFloatingButtonDrag distinguishes dragging from clicking", () => {
  assert.equal(
    didFloatingButtonDrag(
      {
        startX: 10,
        startY: 10,
        currentX: 12,
        currentY: 13,
      },
      4,
    ),
    false,
  );
  assert.equal(
    didFloatingButtonDrag(
      {
        startX: 10,
        startY: 10,
        currentX: 16,
        currentY: 10,
      },
      4,
    ),
    true,
  );
});
