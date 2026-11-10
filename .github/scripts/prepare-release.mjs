import {readFileSync, writeFileSync, mkdirSync, cpSync} from "node:fs";
import {join} from "node:path";

const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GQT_RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Expected GITHUB_REPOSITORY=owner/repository");
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Expected tag v<major>.<minor>.<patch>");
const manifest = JSON.parse(readFileSync("module.json", "utf8"));
if (tag.slice(1) !== manifest.version) throw new Error(`Tag ${tag} does not match module version ${manifest.version}`);
manifest.manifest = `https://github.com/${repository}/releases/latest/download/module.json`;
manifest.download = `https://github.com/${repository}/releases/download/${tag}/guild-quest-tracker.zip`;
const target = "dist/guild-quest-tracker";
mkdirSync(target,{recursive:true});
for (const path of ["main.mjs", "scripts", "templates", "styles", "lang"]) {
  cpSync(path,join(target,path),{recursive:true});
}
const data = JSON.stringify(manifest,null,2)+"\n";
writeFileSync(join(target,"module.json"),data);
writeFileSync("dist/module.json",data);
