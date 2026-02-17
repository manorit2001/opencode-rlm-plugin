---
description: Force primary lane
---

If `$1` is empty, respond with:
`Usage: /contexts-switch <context-id> [ttl-minutes]`

Otherwise call `contexts-switch` with `contextID=$1`.
If `$2` is a positive integer, include `ttlMinutes=$2`.
Return only the tool output.
