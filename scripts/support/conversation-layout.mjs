import assert from "node:assert/strict";

/** Measure the actual reading area, including a card's padding or a list's indentation. */
export async function assertContainerWidth(body, label) {
  await body.scrollIntoViewIfNeeded();
  const layout = await body.evaluate(node => {
    const parent = node.parentElement, box = node.getBoundingClientRect(), outer = parent.getBoundingClientRect();
    const css = getComputedStyle(node), container = getComputedStyle(parent), px = value => parseFloat(value) || 0;
    const left = outer.left + px(container.borderLeftWidth) + px(container.paddingLeft) + px(css.marginLeft);
    const right = outer.right - px(container.borderRightWidth) - px(container.paddingRight) - px(css.marginRight);
    return { left: box.left, right: box.right, width: box.width, expectedLeft: left, expectedRight: right, available: right - left };
  });
  assert.ok(layout.available > 0, `${label}: the reading area is visible`);
  assert.ok(Math.abs(layout.left - layout.expectedLeft) <= 1, `${label}: left edge follows its container`);
  assert.ok(Math.abs(layout.right - layout.expectedRight) <= 1, `${label}: prose uses the available width (${layout.width}px of ${layout.available}px)`);
  return layout;
}
