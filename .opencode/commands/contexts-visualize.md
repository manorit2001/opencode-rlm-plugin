description: Start a web frontend for context-lane visualization
---

Start a lane visualization web frontend backed by the lane sqlite database.

- `$1` optional session ID (defaults to current session)
- `$2` optional host (defaults to configured web host)
- `$3` optional port (defaults to configured web port)
- `$4` optional base path (defaults to configured web base path)

Return only the raw output from the tool.

```ts
const args = {
  ...(argv[0] ? { sessionID: argv[0] } : {}),
  ...(argv[1] ? { host: argv[1] } : {}),
  ...(argv[2] ? { port: Number(argv[2]) } : {}),
  ...(argv[3] ? { basePath: argv[3] } : {}),
}

const result = await tool("contexts-visualize", args)
return result
```
