import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

test("actual noninteractive agent CLI rejects missing, conflicting and unavailable utility authority", async () => {
  await using tmp = await tmpdir()
  const marker = "QUALIFICATION_CLI_POISON_ENV_KEY"
  for (const [args, message] of [
    [[], "requires --account <id> or --legacy-auth"],
    [["--account", "missing-account", "--legacy-auth"], "--account and --legacy-auth cannot be used together"],
    [["--account", "missing-account"], "selected OpenAI account is unavailable"],
  ] as const) {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        "src/index.ts",
        "agent",
        "create",
        "--path",
        tmp.path,
        "--description",
        "qualification",
        "--model",
        "openai/gpt-5.2",
        "--mode",
        "all",
        "--permissions",
        "read",
        ...args,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          KILO_DB: path.join(tmp.path, "store.sqlite"),
          KILO_EXPERIMENTAL_PROVIDER_PROFILES: "1",
          OPENAI_API_KEY: marker,
          KILO_AUTH_CONTENT: "{}",
        },
      },
    )
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(1)
    expect(output + errors).toContain(message)
    expect(output + errors).not.toContain(marker)
    expect(await Bun.file(path.join(tmp.path, "agents", "qualification.md")).exists()).toBe(false)
  }
}, 30_000)
