import assert from "node:assert/strict";
import test from "node:test";

import { url_parameters } from "@blog-system/commutative";

type WindowLike = {
  location: {
    hash: string;
    search: string;
  };
};

test("url_parameters keeps query params separate from hash params", () => {
  const originalWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        hash: "#q=encoded-fragment",
        search: "?admin=1&r=katex"
      }
    } satisfies WindowLike
  });

  try {
    const params = url_parameters();
    assert.equal(params.get("admin"), "1");
    assert.equal(params.get("r"), "katex");
    assert.equal(params.get("q"), "encoded-fragment");
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: WindowLike }).window;
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow
      });
    }
  }
});
