import assert from "node:assert/strict";
import test from "node:test";

import { calculateCameraPan } from "../src/renderer.js";

test("dragging right pans the view toward screen-right", () => {
  const delta = calculateCameraPan(100, 0, 1);
  assert.ok(delta.x > 0, "camera X should increase");
  assert.ok(delta.y < 0, "camera Y should move north-east in world space");
});

test("dragging left pans the view toward screen-left", () => {
  const delta = calculateCameraPan(-100, 0, 1);
  assert.ok(delta.x < 0, "camera X should decrease");
  assert.ok(delta.y > 0, "camera Y should move south-west in world space");
});

test("dragging up pans the view toward screen-up", () => {
  const delta = calculateCameraPan(0, -100, 1);
  assert.ok(delta.x < 0, "camera X should move west");
  assert.ok(delta.y < 0, "camera Y should move north");
});

test("dragging down pans the view toward screen-down", () => {
  const delta = calculateCameraPan(0, 100, 1);
  assert.ok(delta.x > 0, "camera X should move east");
  assert.ok(delta.y > 0, "camera Y should move south");
});

test("a zero-length drag leaves the camera still", () => {
  assert.deepEqual(calculateCameraPan(0, 0, 1), { x: 0, y: 0 });
});
