import { test } from "node:test";
import assert from "node:assert/strict";
import { collectRecipients, formatSearchLine, formatMessageHeaderBlock } from "../src/tools/builtin/google-gmail.js";

test("search lines expose the delivered recipient so forwarded mailboxes are distinguishable", () => {
  const line = formatSearchLine("abc123", [
    { name: "Subject", value: "Invoice" },
    { name: "From", value: "Billing <billing@example.com>" },
    { name: "Date", value: "Mon, 07 Sep 2026 10:00:00 +0000" },
    { name: "To", value: "work@example.com" },
    { name: "Delivered-To", value: "primary@example.com" },
  ]);

  assert.match(line, /^\[abc123\] /);
  assert.ok(line.includes("work@example.com"));
  assert.ok(line.includes("primary@example.com"));
  assert.ok(line.includes("Invoice"));
});

test("recipients are de-duplicated case-insensitively and keep display names", () => {
  const recipients = collectRecipients([
    { name: "To", value: "Owner <Primary@Example.com>, second@example.com" },
    { name: "Delivered-To", value: "primary@example.com" },
    { name: "X-Forwarded-To", value: "third@example.com" },
  ]);

  assert.deepEqual(recipients, [
    "Owner <Primary@Example.com>",
    "second@example.com",
    "third@example.com",
  ]);
});

test("missing recipient headers degrade to a placeholder instead of throwing", () => {
  const line = formatSearchLine("id1", [{ name: "From", value: "a@example.com" }]);
  assert.ok(line.includes("-> ?"));

  const block = formatMessageHeaderBlock([{ name: "From", value: "a@example.com" }]);
  assert.ok(block.includes("To: ?"));
  assert.ok(!block.includes("Cc:"));
});

test("read header block reports sender, recipients, cc, date and subject", () => {
  const block = formatMessageHeaderBlock([
    { name: "From", value: "sender@example.com" },
    { name: "To", value: "work@example.com" },
    { name: "Delivered-To", value: "primary@example.com" },
    { name: "Cc", value: "cc@example.com" },
    { name: "Date", value: "Mon, 07 Sep 2026 10:00:00 +0000" },
    { name: "Subject", value: "Hello" },
  ]);

  assert.equal(
    block,
    [
      "From: sender@example.com",
      "To: work@example.com, primary@example.com",
      "Cc: cc@example.com",
      "Date: Mon, 07 Sep 2026 10:00:00 +0000",
      "Subject: Hello",
    ].join("\n"),
  );
});
