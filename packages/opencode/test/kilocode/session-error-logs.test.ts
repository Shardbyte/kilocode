import { expect, test } from "bun:test"
import path from "node:path"

test("profile session terminal and offline logs exclude internal provider secrets", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "test/kilocode/session-authority-qualification.test.ts",
      "test/kilocode/session-profile-error.test.ts",
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, KILO_PRINT_LOGS: "1" },
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
  expect(log).toContain("selected provider account request failed")
  expect(log).toContain("Provider account connection failed; waiting for network reconnection.")
  for (const marker of [
    "SECRET_ACCESS_A",
    "SECRET_REFRESH_A",
    "SECRET_PROVIDER_ERROR",
    "SECRET_ENV_KEY",
    "SECRET_AUTH_CONTENT",
    "SECRET_HOST",
    "SECRET_ACCESS_URL",
  ]) {
    expect(log).not.toContain(marker)
  }
}, 30_000)
