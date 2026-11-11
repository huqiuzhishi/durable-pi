import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { faux, tempStore } from "./helpers.js";

test("git diff: files changed from the default branch merge base", async () => {
  const t = await tempStore();
  const repo = join(t.work, "project");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  writeFileSync(join(repo, "old.txt"), "old\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").toString().trim();
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "new.txt"), "new\n");
  git("add", "new.txt");
  git("commit", "-q", "-m", "new");
  writeFileSync(join(repo, "base.txt"), "changed\n");
  git("mv", "old.txt", "renamed.txt");
  writeFileSync(join(repo, "untracked.txt"), "not in git diff\n");

  const store = await t.open();
  try {
    const session = await store.create({ name: "repo", cwd: repo, model: faux });
    const diff = await store.gitDiff(store.row(session.id));
    assert.equal(diff.root, repo);
    assert.equal(diff.base, "main");
    assert.equal(diff.mergeBase, base);
    assert.deepEqual(
      diff.files.map(({ status, rel, oldRel }) => ({ status: status[0], rel, oldRel })),
      [
        { status: "M", rel: "base.txt", oldRel: undefined },
        { status: "A", rel: "new.txt", oldRel: undefined },
        { status: "R", rel: "renamed.txt", oldRel: "old.txt" },
      ],
    );
  } finally {
    await store.close();
    await t.cleanup();
  }
});
