import assert from "node:assert/strict";
import test from "node:test";
import { deliverFinalDiscordReply, renderProgress } from "../src/bot.js";
import { MessageFlags } from "discord.js";
import {
  assertDiscordV1Text,
  editTextMessageAsV1,
  extractMessageText,
  messagePayload,
} from "../src/utils/discord-message.js";

test("V1 payload preserves ANSI and plugin-owned text exactly", () => {
  const content = "```ansi\n\u001b[1;36mTitle\u001b[0m :love_this:\n```";
  const payload = messagePayload(content);
  assert.equal(payload.content, content);
  assert.equal(payload.flags, undefined);
  assert.equal(content.charCodeAt(content.indexOf("\u001b")), 27);
});

test("plugin text validation rejects empty and over-limit content", () => {
  assert.throws(() => assertDiscordV1Text("", "plugin message content"), /must not be empty/);
  assert.doesNotThrow(() => assertDiscordV1Text("x".repeat(2000), "plugin message content"));
  assert.throws(
    () => assertDiscordV1Text("x".repeat(2001), "plugin message content"),
    /2000-character V1 limit/,
  );
});

test("forwarded message snapshots remain readable", () => {
  const content = extractMessageText({
    content: "",
    messageSnapshots: {
      values: () => [{
        content: "forwarded text",
        embeds: [{ toJSON: () => ({ title: "forwarded title" }) }],
      }],
    },
  });
  assert.equal(content, "forwarded text\nforwarded title");
});

test("historical Components V2 text remains readable", () => {
  const content = extractMessageText({
    content: "",
    components: [{
      toJSON: () => ({
        type: 17,
        components: [{ type: 10, content: "historical text" }],
      }),
    }],
  });
  assert.equal(content, "historical text");
});

test("V1 attachment-only style edit omits content instead of copying embeds", async () => {
  let editedPayload: unknown;
  const message = {
    id: "old",
    flags: { has: () => false },
    edit: async (payload: unknown) => { editedPayload = payload; },
  };

  const result = await editTextMessageAsV1(message as never, undefined);
  assert.deepEqual(editedPayload, {});
  assert.deepEqual(result, {
    messageId: "old",
    migratedFromComponentsV2: false,
    historicalMessageDeleted: true,
  });
});

test("historical Components V2 edit creates V1 replacement and returns its ID", async () => {
  const sentPayloads: unknown[] = [];
  let deleted = false;
  const message = {
    id: "old",
    flags: { has: (flag: MessageFlags) => flag === MessageFlags.IsComponentsV2 },
    content: "",
    components: [{ toJSON: () => ({ type: 10, content: "old text" }) }],
    channel: {
      send: async (payload: unknown) => {
        sentPayloads.push(payload);
        return { id: "new" };
      },
    },
    delete: async () => { deleted = true; },
  };

  const result = await editTextMessageAsV1(message as never, "new text");
  assert.deepEqual(sentPayloads, [{ content: "new text" }]);
  assert.equal(deleted, true);
  assert.deepEqual(result, {
    messageId: "new",
    migratedFromComponentsV2: true,
    historicalMessageDeleted: true,
  });
});

test("migration returns the replacement ID even when old-message deletion fails", async () => {
  const message = {
    id: "old",
    flags: { has: () => true },
    content: "",
    components: [{ toJSON: () => ({ type: 10, content: "old text" }) }],
    channel: { send: async () => ({ id: "new" }) },
    delete: async () => { throw new Error("missing permission"); },
  };

  const result = await editTextMessageAsV1(message as never, "new text");
  assert.deepEqual(result, {
    messageId: "new",
    migratedFromComponentsV2: true,
    historicalMessageDeleted: false,
  });
});


test("progress rendering keeps only the newest status without exposing tool labels", () => {
  const rendered = renderProgress([
    { kind: "activity", id: "1", text: "📖 Reading the tiny runes..." },
    { kind: "activity", id: "2", text: "🔍 Following a suspicious trail..." },
  ]);
  assert.equal(rendered, "🔍 Following a suspicious trail...");
  assert.doesNotMatch(rendered, /Reading/);
});

test("progress text stays below the Discord V1 content limit", () => {
  const rendered = renderProgress([{ kind: "text", text: "x".repeat(3000) }]);
  assert.ok(rendered.length <= 1900);
});


test("final Discord reply is created before the temporary activity is deleted", async () => {
  const order: string[] = [];
  const sent = await deliverFinalDiscordReply(
    { reply: async () => { order.push("send"); return { id: "final" }; } } as never,
    messagePayload("finished"),
    { delete: async () => { order.push("delete"); } } as never,
  );
  assert.equal(sent.id, "final");
  assert.deepEqual(order, ["send", "delete"]);
});

test("failed final delivery leaves the temporary activity message intact", async () => {
  let deleted = false;
  await assert.rejects(
    deliverFinalDiscordReply(
      { reply: async () => { throw new Error("send failed"); } } as never,
      messagePayload("finished"),
      { delete: async () => { deleted = true; } } as never,
    ),
    /send failed/,
  );
  assert.equal(deleted, false);
});

test("activity deletion failure does not invalidate the delivered final reply", async () => {
  const sent = await deliverFinalDiscordReply(
    { reply: async () => ({ id: "final" }) } as never,
    messagePayload("finished"),
    { delete: async () => { throw new Error("missing permission"); } } as never,
  );
  assert.equal(sent.id, "final");
});
