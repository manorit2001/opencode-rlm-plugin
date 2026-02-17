import { spawn } from "node:child_process"
import type { RecursiveConfig, RLMFocusedContext } from "./types.js"

interface BridgeResponse {
  focused_context?: unknown
  error?: unknown
}

const PYTHON_PROGRAM = String.raw`
import json
import re
import sys

def emit(obj):
    print(json.dumps(obj))

try:
    from rlm import RLM
except Exception as exc:
    emit({"error": f"import_failed: {exc}"})
    sys.exit(2)

payload = json.load(sys.stdin)
archive_context = str(payload.get("archive_context", ""))
latest_goal = str(payload.get("latest_goal", ""))
backend = str(payload.get("backend", "openai"))
model = str(payload.get("model", "gpt-4.1-mini"))
environment = str(payload.get("environment", "local"))
max_depth = int(payload.get("max_depth", 3))
max_iterations = int(payload.get("max_iterations", 8))
max_chars = int(payload.get("max_focused_context_chars", 4500))

if len(archive_context.strip()) == 0:
    emit({"focused_context": ""})
    sys.exit(0)

prompt = (
    "You are Recursive Language Models context engine. "
    "Recursively inspect the archived context and return only what is essential for the next coding turn.\\n"
    f"Latest user goal: {latest_goal}\\n"
    "Return JSON only with this schema: "
    "{\\\"focused_context\\\": string}.\\n"
    "Constraints:\\n"
    "- Include only actionable facts, decisions, and unresolved blockers.\\n"
    "- Preserve concrete file paths, commands, and constraints.\\n"
    "- Exclude repetition and stale tool noise.\\n"
    f"- Keep focused_context under {max_chars} characters.\\n"
    "Archived context:\\n"
    + archive_context
)

try:
    rlm = RLM(
        backend=backend,
        backend_kwargs={"model_name": model},
        environment=environment,
        max_depth=max_depth,
        max_iterations=max_iterations,
        verbose=False,
    )
    completion = rlm.completion(prompt)
    text = getattr(completion, "response", str(completion))
except Exception as exc:
    emit({"error": f"rlm_execution_failed: {exc}"})
    sys.exit(3)

match = re.search(r"\{.*\}", text, re.DOTALL)
if not match:
    emit({"error": "no_json_response", "raw": text})
    sys.exit(4)

try:
    parsed = json.loads(match.group(0))
except Exception as exc:
    emit({"error": f"invalid_json_response: {exc}", "raw": text})
    sys.exit(5)

focused = str(parsed.get("focused_context", "")).strip()
if len(focused) > max_chars:
    focused = focused[:max_chars]

emit({"focused_context": focused})
sys.exit(0)
`

function parseBridgeResponse(raw: string): RLMFocusedContext {
  const parsed = JSON.parse(raw) as BridgeResponse
  if (parsed.error) {
    throw new Error(String(parsed.error))
  }

  const focused = parsed.focused_context
  if (typeof focused !== "string") {
    throw new Error("Bridge returned invalid focused_context")
  }

  return {
    focusedContext: focused,
  }
}

export async function generateFocusedContextWithRLM(
  archiveContext: string,
  latestGoal: string,
  config: RecursiveConfig,
): Promise<RLMFocusedContext> {
  const payload = {
    archive_context: archiveContext,
    latest_goal: latestGoal,
    backend: config.backend,
    model: config.model,
    environment: config.environment,
    max_depth: config.maxDepth,
    max_iterations: config.maxIterations,
    max_focused_context_chars: config.maxFocusedContextChars,
  }

  const child = spawn(config.pythonBin, ["-c", PYTHON_PROGRAM], {
    stdio: ["pipe", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""

  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })

  child.stdin.write(JSON.stringify(payload))
  child.stdin.end()

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`RLM bridge timed out after ${config.timeoutMs}ms`))
    }, config.timeoutMs)

    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit=${exitCode}`
    throw new Error(`RLM bridge failed: ${detail}`)
  }

  const raw = stdout.trim()
  if (!raw) {
    throw new Error("RLM bridge returned empty output")
  }

  return parseBridgeResponse(raw)
}
