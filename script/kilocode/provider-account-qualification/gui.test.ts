import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { main } from "./gui"

describe("historical GUI qualification", () => {
  test("records unavailable source without classifying it as executed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gui-qualification-"))
    const dest = path.join(dir, "result.json")
    try {
      const result = await main(["vscode", "34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12", path.join(dir, "missing"), dest])
      const saved = JSON.parse(await readFile(dest, "utf8"))
      expect(result.classification).toBe("UNAVAILABLE")
      expect(saved.schema).toBe(1)
      expect(saved.items).toHaveLength(3)
      expect(saved.items.map((item: { status: string }) => item.status)).toEqual(["NOT_RUN", "NOT_RUN", "NOT_RUN"])
      expect(saved.items.every((item: { evidence: string }) => item.evidence === "NOT_RUN")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("deferred mode records desktop NOT_RUN with historical source provenance", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gui-qualification-"))
    const dest = path.join(dir, "result.json")
    try {
      await main(["deferred", "vscode", dest])
      const saved = JSON.parse(await readFile(dest, "utf8"))
      expect(saved.schema).toBe(1)
      expect(saved.items.find((item: { id: string }) => item.id === "historical-vscode:guiFlow")).toMatchObject({
        status: "NOT_RUN",
        evidence: "NOT_RUN",
      })
      expect(saved.details.provenance.sourceSha).toBe("34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12")
      expect(saved.details.guiFlow.reason).toContain("not asserted")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects unapproved commits and in-checkout sources", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gui-qualification-"))
    try {
      await expect(
        main(["vscode", "58c28a4261dbe8ca4dc7f8a6455fec74a31e3e5b", dir, path.join(dir, "out.json")]),
      ).rejects.toThrow("unsupported-historical-checkpoint")
      await expect(
        main([
          "vscode",
          "34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12",
          path.resolve(import.meta.dir, "../../.."),
          path.join(dir, "out.json"),
        ]),
      ).rejects.toThrow("historical-source-must-be-outside-checkout")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
