import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/attachment-index.ts", import.meta.url), "utf8");

test("all attachment OCR uses the managed cache instead of the process cwd", () => {
  assert.match(source, /createWorker\("eng\+chi_tra", undefined, \{ cachePath \}\)/);
  assert.match(source, /OfficeParser\.parseOffice\([\s\S]*?ocr: false,/);
  assert.doesNotMatch(source, /OfficeParser\.parseOffice\([\s\S]*?ocr: true,/);
  assert.match(source, /imageOcr\(Buffer\.from\(attachment\.data, "base64"\)\)/);
});
