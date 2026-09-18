/**
 * Tests for `pdf-export-helpers` — all pure functions, no Electron or DOM.
 *
 * Run with: `tsx --test "src/pdf-export-helpers.test.ts"`
 *
 * @module pdf-export-helpers.test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clamp,
  ensurePdfExtension,
  formatBytes,
  printMarginsMmToInches,
  sanitizePdfFilename,
  shouldConfirmPdfOverwrite,
  withTimeout,
} from "./pdf-export-helpers";

// ---------------------------------------------------------------------------
// sanitizePdfFilename
// ---------------------------------------------------------------------------
describe("sanitizePdfFilename", () => {
  it("returns 'article.pdf' for empty string", () => {
    assert.equal(sanitizePdfFilename(""), "article.pdf");
  });

  it("returns 'article.pdf' for whitespace string", () => {
    assert.equal(sanitizePdfFilename("   "), "article.pdf");
  });

  it("appends .pdf when no extension is present", () => {
    assert.equal(sanitizePdfFilename("MyReport"), "MyReport.pdf");
  });

  it("preserves an already-present lowercase .pdf", () => {
    assert.equal(sanitizePdfFilename("report.pdf"), "report.pdf");
  });

  it("preserves an already-present uppercase .PDF", () => {
    assert.equal(sanitizePdfFilename("report.PDF"), "report.PDF");
  });

  it("preserves mixed-case .Pdf", () => {
    assert.equal(sanitizePdfFilename("report.Pdf"), "report.Pdf");
  });

  it("strips leading directory separators (forward slash)", () => {
    assert.equal(sanitizePdfFilename("/some/path/article"), "article.pdf");
  });

  it("strips leading directory separators (backslash on any platform)", () => {
    assert.equal(sanitizePdfFilename("C:\\Users\\test\\article"), "article.pdf");
  });

  it("handles filename with dots before .pdf", () => {
    assert.equal(sanitizePdfFilename("my.report.pdf"), "my.report.pdf");
  });

  it("appends .pdf when filename has a non-.pdf extension", () => {
    assert.equal(sanitizePdfFilename("draft.docx"), "draft.docx.pdf");
  });

  it("normalises mixed separators", () => {
    assert.equal(sanitizePdfFilename("dir1/dir2\\file"), "file.pdf");
  });
});

// ---------------------------------------------------------------------------
// ensurePdfExtension
// ---------------------------------------------------------------------------
describe("ensurePdfExtension", () => {
  it("appends .pdf to a path without extension", () => {
    assert.equal(ensurePdfExtension("/home/user/output"), "/home/user/output.pdf");
  });

  it("preserves path already ending with .pdf (lowercase)", () => {
    assert.equal(
      ensurePdfExtension("/home/user/output.pdf"),
      "/home/user/output.pdf",
    );
  });

  it("preserves path already ending with .PDF (uppercase)", () => {
    assert.equal(
      ensurePdfExtension("C:\\Users\\test\\report.PDF"),
      "C:\\Users\\test\\report.PDF",
    );
  });

  it("preserves mixed-case .Pdf", () => {
    assert.equal(ensurePdfExtension("doc.Pdf"), "doc.Pdf");
  });

  it("appends .pdf to a path with non-.pdf extension", () => {
    assert.equal(
      ensurePdfExtension("/tmp/export.doc"),
      "/tmp/export.doc.pdf",
    );
  });

  it("appends .pdf to a bare filename", () => {
    assert.equal(ensurePdfExtension("output"), "output.pdf");
  });
});

// ---------------------------------------------------------------------------
// clamp
// ---------------------------------------------------------------------------
describe("clamp", () => {
  it("returns the value when within bounds", () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  it("clamps to min when value is below", () => {
    assert.equal(clamp(-1, 0, 10), 0);
  });

  it("clamps to max when value is above", () => {
    assert.equal(clamp(15, 0, 10), 10);
  });

  it("handles edge equal to min", () => {
    assert.equal(clamp(0, 0, 10), 0);
  });

  it("handles edge equal to max", () => {
    assert.equal(clamp(10, 0, 10), 10);
  });

  it("handles negative bounds", () => {
    assert.equal(clamp(-5, -10, -1), -5);
  });
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------
describe("formatBytes", () => {
  it("formats bytes less than 1024", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1023), "1023 B");
  });

  it("formats kilobytes", () => {
    assert.equal(formatBytes(1024), "1.00 kB");
    assert.equal(formatBytes(1536), "1.50 kB");
  });

  it("formats megabytes", () => {
    assert.equal(formatBytes(1048576), "1.00 MB");
    assert.equal(formatBytes(1572864), "1.50 MB");
  });
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------
describe("withTimeout", () => {
  it("resolves when the promise resolves before the timeout", async () => {
    const result = await withTimeout(
      Promise.resolve(42),
      1000,
      "should not fire",
    );
    assert.equal(result, 42);
  });

  it("rejects when the promise rejects before the timeout", async () => {
    await assert.rejects(
      withTimeout(Promise.reject(new Error("boom")), 1000, "test"),
      /boom/,
    );
  });

  it("rejects with a timeout error when the promise is too slow", async () => {
    await assert.rejects(
      withTimeout(
        new Promise((_resolve) => {
          /* never settles */
        }),
        50,
        "slow operation",
      ),
      /slow operation timed out after 50ms/,
    );
  });
});

// ---------------------------------------------------------------------------
// shouldConfirmPdfOverwrite
// ---------------------------------------------------------------------------
describe("shouldConfirmPdfOverwrite", () => {
  it("returns false when original and target are the same path (no .pdf added)", () => {
    assert.equal(
      shouldConfirmPdfOverwrite("/path/report.pdf", "/path/report.pdf", true),
      false,
    );
  });

  it("returns false when target does not exist", () => {
    assert.equal(
      shouldConfirmPdfOverwrite("/path/report", "/path/report.pdf", false),
      false,
    );
  });

  it("returns true when .pdf was appended and target already exists", () => {
    assert.equal(
      shouldConfirmPdfOverwrite("/path/report", "/path/report.pdf", true),
      true,
    );
  });

  it("returns false when .pdf was appended but target does not exist", () => {
    assert.equal(
      shouldConfirmPdfOverwrite("/path/report", "/path/report.pdf", false),
      false,
    );
  });

  it("returns false when original already has .PDF (uppercase) and target unchanged", () => {
    assert.equal(
      shouldConfirmPdfOverwrite("/path/report.PDF", "/path/report.PDF", true),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// printMarginsMmToInches
// ---------------------------------------------------------------------------
describe("printMarginsMmToInches", () => {
  const mmPerInch = 25.4;

  it("converts standard 20/15 mm margins to inches", () => {
    const result = printMarginsMmToInches({ top: 20, right: 15, bottom: 20, left: 15 });
    assert.ok(Math.abs(result.top - 20 / mmPerInch) < 1e-9, `top=${result.top}`);
    assert.ok(Math.abs(result.bottom - 20 / mmPerInch) < 1e-9, `bottom=${result.bottom}`);
    assert.ok(Math.abs(result.left - 15 / mmPerInch) < 1e-9, `left=${result.left}`);
    assert.ok(Math.abs(result.right - 15 / mmPerInch) < 1e-9, `right=${result.right}`);
  });

  it("clamps values above 50 mm to 50 mm", () => {
    const result = printMarginsMmToInches({ top: 999, right: 0, bottom: 0, left: 0 });
    assert.ok(Math.abs(result.top - 50 / mmPerInch) < 1e-9, `top=${result.top}`);
  });

  it("clamps negative values to 0", () => {
    const result = printMarginsMmToInches({ top: -5, right: 0, bottom: 0, left: 0 });
    assert.equal(result.top, 0);
  });

  it("treats non-numeric input as 0", () => {
    const result = printMarginsMmToInches({ top: "abc" as unknown as number, right: undefined as unknown as number, bottom: 0, left: 0 });
    assert.equal(result.top, 0);
    assert.equal(result.right, 0);
  });
});
