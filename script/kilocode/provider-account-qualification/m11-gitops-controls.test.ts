import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { inspectBytes, normalizeArgv } from "./m11-gitops-controls"

test("classifies fixed LF and CRLF fixture bytes without retaining contents", () => {
  expect(inspectBytes(Buffer.from("one\n", "ascii"))).toMatchObject({
    length: 4,
    lf: 1,
    crlf: 0,
    expected: "before",
    normalizedBefore: true,
    normalizedAfter: false,
  })
  expect(inspectBytes(Buffer.from("one\r\n", "ascii"))).toMatchObject({
    length: 5,
    lf: 1,
    crlf: 1,
    expected: "before-crlf",
    normalizedBefore: true,
    normalizedAfter: false,
  })
  expect(inspectBytes(Buffer.from("two\n", "ascii"))).toMatchObject({
    expected: "after",
    normalizedBefore: false,
    normalizedAfter: true,
  })
  expect(inspectBytes(Buffer.from("two\r\n", "ascii"))).toMatchObject({
    expected: "after-crlf",
    normalizedBefore: false,
    normalizedAfter: true,
  })
  expect(inspectBytes(undefined)).toMatchObject({
    expected: "missing",
    normalizedBefore: false,
    normalizedAfter: false,
  })
})

test("normalizes whole paths instead of retaining temporary directory suffixes", () => {
  const repo = path.join(os.tmpdir(), "m11-private-root")
  const worktree = path.join(repo, ".kilo", "worktrees", "m11-private-worktree")
  expect(
    normalizeArgv(
      [`--dir=${worktree}`, path.join(repo, "packages", "file.ts"), path.join(os.tmpdir(), "private-user", "file")],
      repo,
      worktree,
    ),
  ).toEqual(["--dir=<WORKTREE>", "<REPO>", "<TEMP>"])
})
