import { describe, expect, test } from "bun:test"
import { passed, summarize } from "./m10-hosted-confirmation"

const caller = "Agent.generate and roll-call fail safely for real SDK errors and captured production output"
const utility = "commit-message utility generation failure logs the actual sanitized error line"
const good = {
  code: 0,
  timeout: false,
  count: { passed: 137, failed: 0, skipped: 0, assertions: 428 },
  failed: [],
  passedTitles: [caller, utility],
  metadataOK: true,
}

describe("M10 hosted confirmation summary", () => {
  test("recognizes named passes only inside their source file blocks", () => {
    expect(
      passed(
        [
          "test/kilocode/qualification/other.test.ts:",
          `(pass) ${caller} [1.00ms]`,
          "test/kilocode/qualification/caller-failures.test.ts:",
          `(pass) ${caller} [2.00ms]`,
          "test/kilocode/qualification/utility-inference.test.ts:",
          `(pass) ${utility} [3.00ms]`,
        ].join("\r\n"),
      ),
    ).toEqual([caller, utility])
    expect(passed(`test/kilocode/qualification/other.test.ts:\n(pass) ${caller} [1.00ms]`)).toEqual([])
  })

  test("requires canonical denominator, zero failures/skips, metadata, and both named pass entries", () => {
    expect(summarize(good)).toMatchObject({
      status: "PASS",
      category: "none",
      passed: 137,
      failed: 0,
      skipped: 0,
      callerPassed: true,
      utilityInferencePassed: true,
      utilityChildPassed: null,
      childEvidence: "unknown-from-parent-suite",
    })
    expect(summarize({ ...good, count: { ...good.count, passed: 136 } }).category).toBe("denominator-mismatch")
    expect(summarize({ ...good, count: { ...good.count, passed: 138 } }).category).toBe("denominator-mismatch")
    expect(summarize({ ...good, count: { ...good.count, passed: 136, failed: 1 } }).category).toBe("test-failure")
    expect(summarize({ ...good, count: { ...good.count, skipped: 1 } }).category).toBe("denominator-mismatch")
    expect(summarize({ ...good, passedTitles: [utility] }).category).toBe("evidence-incomplete")
    expect(summarize({ ...good, passedTitles: [caller] }).category).toBe("evidence-incomplete")
    expect(summarize({ ...good, metadataOK: false }).category).toBe("metadata-mismatch")
    expect(summarize({ ...good, code: 1 }).status).toBe("FAIL")
  })

  test("separates setup, timeout, missing denominator, and unexpected process failures", () => {
    expect(summarize({ ...good, code: undefined }).category).toBe("setup-failure")
    expect(summarize({ ...good, timeout: true }).category).toBe("timeout")
    expect(summarize({ ...good, count: undefined }).category).toBe("denominator-unverified")
    expect(summarize({ ...good, code: 2 }).category).toBe("unexpected-failure")
  })

  test("only serializes fixed source-attested names and safe categories", () => {
    const result = summarize({
      ...good,
      code: 1,
      count: { passed: 136, failed: 1, skipped: 0, assertions: 428 },
      failed: [
        {
          file: "test/kilocode/qualification/caller-failures.test.ts",
          name: `caller suite > ${caller}`,
          category: "assertion-failure",
        },
        {
          file: "test/kilocode/qualification/utility-inference.test.ts",
          name: utility,
          category: "assertion-failure",
        },
        {
          file: "test/kilocode/qualification/other.test.ts",
          name: "private diagnostic output",
          category: "unknown-safe",
        },
      ],
      passedTitles: [],
    })
    expect(result).toMatchObject({
      status: "FAIL",
      category: "test-failure",
      callerPassed: false,
      utilityInferencePassed: false,
      utilityChildPassed: null,
      childEvidence: "unknown-from-parent-suite",
      failedFiles: [
        { file: "test/kilocode/qualification/caller-failures.test.ts", category: "assertion-failure" },
        {
          file: "test/kilocode/qualification/utility-inference.test.ts",
          title: utility,
          category: "assertion-failure",
        },
        { file: "test/kilocode/qualification/other.test.ts", category: "unknown-safe" },
      ],
    })
    expect(JSON.stringify(result)).not.toContain("private diagnostic output")
    expect(JSON.stringify(result)).not.toMatch(/stack|stdout|stderr|token/i)
  })
})
