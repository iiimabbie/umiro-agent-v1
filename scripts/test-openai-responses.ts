import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { callResponsesWebSearch } from "../src/llm/adapters/openai-responses.js";

let receivedBody: Record<string, unknown> | undefined;
let receivedAuth = "";
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    receivedAuth = String(request.headers.authorization ?? "");
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_test",
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: "Search result",
          annotations: [
            { type: "url_citation", title: "Example", url: "https://example.com/a" },
            { type: "url_citation", title: "Duplicate", url: "https://example.com/a" },
            { type: "other", url: "https://example.com/ignored" },
          ],
        }],
      }],
    }));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
try {
  const result = await callResponsesWebSearch({ name: "test", protocol: "openai_chat_completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "test-key", auth: "bearer", model: "test-model", reasoningEffort: "default", tokenLimitField: "max_completion_tokens", capabilities: { vision: true, function_tools: true, responses: true, hosted_web_search: true, hosted_image_generation: false, hosted_code_execution: false } }, "test query", 321);
  assert.equal(receivedAuth, "Bearer test-key");
  assert.equal(receivedBody?.model, "test-model");
  assert.deepEqual(receivedBody?.input, [{ role: "user", content: [{ type: "input_text", text: "test query" }] }]);
  assert.equal(receivedBody?.max_output_tokens, 321);
  assert.deepEqual(receivedBody?.tools, [{ type: "web_search" }]);
  assert.equal(result.text, "Search result");
  assert.deepEqual(result.sources, [{ title: "Duplicate", url: "https://example.com/a" }]);
  assert.equal(result.responseId, "resp_test");
} finally {
  server.close();
  await once(server, "close");
}
console.log("openai responses adapter tests passed");
