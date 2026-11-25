import assert from "node:assert/strict";
import test from "node:test";
import { buildSendMessagePayload } from "../../../lib/server/telegram/client.ts";

test("builds sendMessage payload with explicit entities and disabled previews", () => {
  const payload = buildSendMessagePayload({
    chatId: 123456789,
    text: "Marcus Aurelius: Keep attention on what is yours.",
    entities: [
      {
        type: "bold",
        offset: 0,
        length: 17
      }
    ]
  });

  assert.deepEqual(payload, {
    chat_id: 123456789,
    text: "Marcus Aurelius: Keep attention on what is yours.",
    entities: [
      {
        type: "bold",
        offset: 0,
        length: 17
      }
    ],
    link_preview_options: {
      is_disabled: true
    }
  });
  assert.equal("parse_mode" in payload, false);
});
