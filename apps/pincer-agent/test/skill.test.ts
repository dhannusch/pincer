import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { installSkill } from "../src/skill.js";

function withTmpHome(fn: (tmpHome: string) => void | Promise<void>) {
  return async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pincer-test-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    try {
      await fn(tmpHome);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  };
}

test(
  "installSkill creates SKILL.md with worker URL",
  withTmpHome((tmpHome) => {
    const resultPath = installSkill("https://pincer.example.workers.dev");

    assert.equal(fs.existsSync(resultPath), true);
    assert.match(resultPath, /SKILL\.md$/);

    const content = fs.readFileSync(resultPath, "utf-8");
    assert.match(content, /Pincer/);
    assert.match(content, /https:\/\/pincer\.example\.workers\.dev/);
    assert.match(content, /pincer-agent adapters propose/);
    assert.match(content, /pincer-admin proposals approve/);
    assert.match(content, /pincer-admin adapters apply/);
  })
);

test(
  "installSkill creates nested directory structure",
  withTmpHome((tmpHome) => {
    installSkill("https://test.workers.dev");

    const skillDir = path.join(tmpHome, ".openclaw", "skills", "pincer");
    assert.equal(fs.existsSync(skillDir), true);
  })
);
