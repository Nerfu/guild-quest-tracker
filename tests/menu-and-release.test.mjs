import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read = path => readFileSync(new URL(path, import.meta.url),"utf8");
test("JSON import/export submenu is registered during Foundry init", () => {
  const source = read("../main.mjs");
  assert.match(source, /Hooks\.once\("init",/);
  assert.match(source, /game\.settings\.registerMenu\("guild-quest-tracker", "jsonImportExport"/);
  assert.match(source, /GuildAdminWindow\.runtime = runtime/);
  assert.match(source, /restricted:true/);
});
test("JSON import/export actions keep their existing behavior", () => {
  const ui = read("../scripts/ui.mjs");
  const markup = read("../templates/admin.hbs");
  assert.match(ui,/onImport\(\)\{this\.runtime\.chooseReplacementLibrary\(\);\}/);
  assert.match(ui,/onExport\(\)\{this\.runtime\.exportProgress\(\);\}/);
  assert.match(markup,/>Импорт JSON<\/button>/);
  assert.match(markup,/>Экспорт JSON<\/button>/);
});
test("release also triggers on main branch and supports manual runs", () => {
  const workflow = read("../.github/workflows/release.yml");
  assert.match(workflow,/branches: \[main\]/);
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/pull_request:/);
  assert.match(workflow,/if: github.event_name != 'pull_request'/);
});
