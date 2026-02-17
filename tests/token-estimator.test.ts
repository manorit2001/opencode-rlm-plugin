import test from "node:test"
import assert from "node:assert/strict"
import { estimateConversationTokens } from "../lib/token-estimator.js"

test("estimateConversationTokens returns positive token count", () => {
  const tokens = estimateConversationTokens([
    {
      role: "user",
      parts: [
        {
          type: "text",
          text: "Please inspect src/index.ts and src/lib/config.ts",
        },
      ],
    },
  ])

  assert.ok(tokens > 0)
})
