import { describe, expect, test } from "bun:test"
import { classify, commands } from "./windows-probe"

describe("Windows Git qualification probe", () => {
  test("targets only the two named regressions and the bounded worktree file", () => {
    expect(commands()).toEqual([
      {
        id: "git-ops-apply-patch",
        file: "tests/unit/git-ops.test.ts",
        name: "GitOps > applyPatch > applies changes to the working tree",
        pattern: "^GitOps > applyPatch > applies changes to the working tree$",
      },
      {
        id: "worktree-hook-tolerance",
        file: "tests/unit/worktree-manager.test.ts",
        name: "WorktreeManager.createWorktree > retains post-checkout hook failure tolerance with parallel checkout",
        pattern:
          "^WorktreeManager.createWorktree > retains post-checkout hook failure tolerance with parallel checkout$",
      },
      { id: "worktree-file-unnamed", file: "tests/unit/worktree-manager.test.ts" },
    ])
  })

  test("reduces source-validated assertion sites to fixed categories only", async () => {
    expect(await classify("git-ops-apply-patch", "at test (C:\\private\\git-ops.test.ts:515:19)", 1)).toEqual([
      "working-tree-content-assertion",
    ])
    expect(await classify("worktree-hook-tolerance", "at test (/private/worktree-manager.test.ts:517:5)", 1)).toEqual([
      "worktree-registration-assertion",
    ])
    expect(await classify("worktree-file-unnamed", "at test (/private/worktree-manager.test.ts:34:5)", 1)).toEqual([
      "fixture-command-failure",
    ])
    expect(await classify("worktree-file-unnamed", "at test (/private/worktree-manager.test.ts:40:5)", 1)).toEqual([
      "unknown-safe",
    ])
  })
})
