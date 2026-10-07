import { describe, expect, test } from "bun:test"
import { summary } from "./m11-windows-fixture-confirmation"

describe("Windows fixture summary", () => {
  test("accepts attested counts and correctly scoped target passes", () => {
    const label = "GitOps > applyPatch > applies changes to the working tree"
    const text = `tests/unit/git-ops.test.ts:\n(pass) ${label} [1ms]\n54 pass\n0 fail\n12 expect() calls`
    expect(summary(text, 54, [{ file: "packages/kilo-vscode/tests/unit/git-ops.test.ts", label }]).valid).toBe(true)
    expect(summary(text, 54, [{ file: "packages/kilo-vscode/tests/unit/git-ops.test.ts", label }]).targets).toEqual([
      label,
    ])
  })

  test("rejects denominator mismatch and pass attributed to another file", () => {
    const label = "GitOps > applyPatch > applies changes to the working tree"
    const text = `tests/unit/other.test.ts:\n(pass) ${label} [1ms]\n53 pass\n0 fail`
    expect(summary(text, 54, [{ file: "packages/kilo-vscode/tests/unit/git-ops.test.ts", label }]).valid).toBe(false)
    expect(summary(text, 54, [{ file: "packages/kilo-vscode/tests/unit/git-ops.test.ts", label }]).targets).toEqual([])
  })

  test("rejects skipped or failed cases", () => {
    expect(summary("54 pass\n0 fail\n1 skip", 54, []).valid).toBe(false)
    expect(summary("54 pass\n1 fail\n0 skip", 54, []).valid).toBe(false)
  })

  test("scopes separate target titles to each file in a combined recap", () => {
    const one = "GitOps > applyPatch > applies changes to the working tree"
    const two = "WorktreeManager.createWorktree > retains post-checkout hook failure tolerance with parallel checkout"
    const text = `tests/unit/git-ops.test.ts:\n(pass) ${one} [1ms]\ntests/unit/worktree-manager.test.ts:\n(pass) ${two} [1ms]\n186 pass\n0 fail`
    const selected = [
      { file: "packages/kilo-vscode/tests/unit/git-ops.test.ts", label: one },
      { file: "packages/kilo-vscode/tests/unit/worktree-manager.test.ts", label: two },
    ]
    expect(summary(text, 186, selected).targets).toEqual([one, two])
    expect(summary(text.replace(`(pass) ${two}`, `(pass) ${one}`), 186, selected).targets).toEqual([one])
    expect(summary("186 pass\n0 fail", 186, selected).targets).toEqual([])
  })
})
