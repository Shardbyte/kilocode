import { expect, test } from "bun:test"
import path from "node:path"

test("production OTLP exporters exclude secrets from a hostile failed session", async () => {
  const rows: Array<{ path: string; body: string; auth: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      rows.push({ path: new URL(req.url).pathname, body: await req.text(), auth: req.headers.get("x-qualification") })
      return new Response(null, { status: 200 })
    },
  })
  const root = path.resolve(import.meta.dir, "../../..")
  const env = {
    ...process.env,
    KILO_TEST_OTLP_ENDPOINT: `http://127.0.0.1:${server.port}`,
    KILO_TEST_OTLP_HEADERS: "x-qualification=hostile-session",
  }
  const opts = { cwd: root, env, stdout: "pipe" as const, stderr: "pipe" as const, windowsHide: true }
  try {
    const control = `
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = process.env.KILO_TEST_OTLP_ENDPOINT
      process.env.OTEL_EXPORTER_OTLP_HEADERS = process.env.KILO_TEST_OTLP_HEADERS
      const { Effect } = await import("effect")
      const { Observability } = await import("@opencode-ai/core/observability")
      const effect = Effect.logInfo("OTLP_QUALIFICATION_LOG_CONTROL").pipe(
        Effect.withSpan("OTLP_QUALIFICATION_TRACE_CONTROL"),
        Effect.provide(Observability.layer),
      )
      await Effect.runPromise(Effect.scoped(effect))
    `
    const positive = Bun.spawn([process.execPath, "-e", control], opts)
    const [controlOut, controlErr, controlCode] = await Promise.all([
      new Response(positive.stdout).text(),
      new Response(positive.stderr).text(),
      positive.exited,
    ])
    expect(controlCode, `${controlOut}\n${controlErr}`).toBe(0)
    const baseline = rows.length

    const child = Bun.spawn(
      [
        process.execPath,
        "--config=test/kilocode/qualification/otlp-child.bunfig.toml",
        "test",
        "--timeout",
        "30000",
        "--test-name-pattern",
        "traces hostile provider errors through real session HTTP",
        "test/kilocode/session-authority-qualification.test.ts",
      ],
      opts,
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${out}\n${err}`).toBe(0)
    expect(`${out}\n${err}`).toContain("Ran 1 test across 1 file")
    expect(`${out}\n${err}`).toContain("1 pass")
    const session = rows.slice(baseline)
    if (!session.length) throw new Error(`actual session emitted no OTLP batches\n${out}\n${err}`)
    const controlRows = session.filter((row) => row.body.includes("OTLP_SESSION_CHILD_PRELOAD_"))
    const runtime = session.filter((row) => !row.body.includes("OTLP_SESSION_CHILD_PRELOAD_"))
    const text = JSON.stringify(runtime)
    expect(controlRows.map((row) => row.path)).toContain("/v1/logs")
    expect(controlRows.map((row) => row.path)).toContain("/v1/traces")
    expect(runtime.map((row) => row.path)).toContain("/v1/logs")
    expect(runtime.map((row) => row.path)).toContain("/v1/traces")
    expect(rows.map((row) => row.path)).toContain("/v1/logs")
    expect(rows.map((row) => row.path)).toContain("/v1/traces")
    expect(rows.every((row) => row.auth === "hostile-session")).toBe(true)
    expect(JSON.stringify(rows)).toContain("OTLP_QUALIFICATION_LOG_CONTROL")
    expect(JSON.stringify(rows)).toContain("OTLP_QUALIFICATION_TRACE_CONTROL")
    for (const marker of ["SECRET_ACCESS_A", "SECRET_REFRESH_A", "SECRET_PROVIDER_ERROR", "SECRET_ENV_KEY"])
      expect(text).not.toContain(marker)
  } finally {
    server.stop()
  }
}, 60_000)
