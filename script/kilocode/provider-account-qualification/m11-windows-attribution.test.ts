import { expect, test } from "bun:test"
import { locations } from "./m11-windows-attribution"

test("retains only known test paths and bounded numeric source locations", () => {
  expect(
    locations(
      "arbitrary-content C:\\temp\\git-ops.test.ts:128:7\nworktree-manager.test.ts:514:11\nworktree-manager.test.ts:9000:1",
      [300, 800],
    ),
  ).toEqual([
    { file: "tests/unit/git-ops.test.ts", line: 128 },
    { file: "tests/unit/worktree-manager.test.ts", line: 514 },
  ])
})
