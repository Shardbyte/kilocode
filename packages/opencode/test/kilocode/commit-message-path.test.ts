import { describe, expect, test } from "bun:test"
import { validateRepoPath } from "../../src/kilocode/commit-message/git-context"
import { tmpdir } from "../fixture/fixture"

describe("commit-message repository routing", () => {
  test("accepts only the repository rooted at the routed worktree", async () => {
    await using repo = await tmpdir({ git: true })
    await using other = await tmpdir({ git: true })

    await expect(validateRepoPath(repo.path, repo.path)).resolves.toBeUndefined()
    await expect(validateRepoPath(other.path, repo.path)).rejects.toThrow(
      "Repository path is outside the routed workspace",
    )
  })
})
