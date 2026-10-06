import { expect, test } from "bun:test"
import path from "node:path"

test("profile task migration teardown does not change subsequent OpenAI LLM or native authority", async () => {
  const env = { ...process.env }
  delete env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  env.KILO_RECORDED_SCENARIO = "openai-oauth"
  env.RECORD = "false"
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "test/tool/task.test.ts",
      "test/session/llm.test.ts",
      "test/session/llm-native-recorded.test.ts",
      "--test-name-pattern",
      "session binding migration persists once|sends responses API payload for OpenAI models|OpenAI OAuth: drives a tool loop",
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const log = out + err
  expect(code).toBe(0)
  expect(log).toContain("3 pass")
  expect(log).toContain("0 fail")
  expect(log).not.toContain("This session requires an OpenAI account binding")
}, 30_000)
