import assert from "node:assert/strict";
import { test } from "node:test";
import { menuApply } from "../src/app.mjs";

// The app's apply handler is wired through menuApply; these tests exercise
// the real exported seam with a stub menu, so the apply no-op vs one-close
// decision is verified without a TTY.
function stubMenu(changed) {
  return {
    applied: 0,
    apply() {
      this.applied++;
      return changed;
    },
  };
}

test("menuApply with an effective change invokes onChanged exactly once", () => {
  const menu = stubMenu(true);
  let changed = 0;
  let unchanged = 0;
  menuApply(menu, { onChanged: () => changed++, onUnchanged: () => unchanged++ });
  assert.equal(menu.applied, 1);
  assert.equal(changed, 1);
  assert.equal(unchanged, 0);
});

test("menuApply with no effective change invokes onUnchanged, not onChanged", () => {
  const menu = stubMenu(false);
  let changed = 0;
  let unchanged = 0;
  menuApply(menu, { onChanged: () => changed++, onUnchanged: () => unchanged++ });
  assert.equal(menu.applied, 1);
  assert.equal(changed, 0);
  assert.equal(unchanged, 1);
});
