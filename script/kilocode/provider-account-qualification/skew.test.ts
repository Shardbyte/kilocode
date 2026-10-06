import { expect, test } from "bun:test"
import { runSkew } from "./skew"

test("skew qualification records verified source, real fail-closed HTTP, and unsupported CLI directions honestly", async () => {
  const result = await runSkew()
  expect(result).toMatchObject([
    { id: "historical-protocol:source", status: "PASS", evidence: "SOURCE_INSPECTION" },
    { id: "historical-protocol:http", status: "PASS", evidence: "REAL_HTTP_HISTORICAL_PROTOCOL", exit: 0 },
    { id: "historical-cli-skew:remote-target-audit", status: "PASS", evidence: "SOURCE_INSPECTION" },
    { id: "historical-cli-skew:old-cli-to-current-http", status: "NOT_RUN", evidence: "NOT_RUN" },
    { id: "historical-cli-skew:current-cli-to-old-http", status: "NOT_RUN", evidence: "NOT_RUN" },
  ])
  expect(JSON.stringify(result)).not.toMatch(/(?:access|refresh|credential|authorization|stdout|stderr)/i)
  const info = result[0]?.details?.files as Array<{ sha256: string; requestLine: number }>
  expect(info).toHaveLength(2)
  expect(info.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && file.requestLine > 0)).toBe(true)
  expect(result[2]?.details?.currentServerLine).toBeGreaterThan(0)
})

test("CLI-only collection includes both unexecuted skew directions without running HTTP protocol tests", async () => {
  const result = await runSkew("cli")
  expect(result.map((item) => item.id)).toEqual([
    "historical-cli-skew:remote-target-audit",
    "historical-cli-skew:old-cli-to-current-http",
    "historical-cli-skew:current-cli-to-old-http",
  ])
  expect(result.slice(1).every((item) => item.status === "NOT_RUN" && item.evidence === "NOT_RUN")).toBe(true)
})
