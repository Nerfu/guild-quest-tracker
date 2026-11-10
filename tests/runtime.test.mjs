import test from "node:test";
import assert from "node:assert/strict";
import {GuildRuntime} from "../scripts/runtime.mjs";

// Small synthetic testing fixture. The actual quest/event library stays outside the code repository.
const demo = {
  formatVersion: 1,
  facts: {road_bypassed:false},
  events: [
    {id:"guild-visit",title:"Гильдия",description:"Разговор в гильдии",repeatable:true,actions:[
      {id:"info",label:"Сведения",playerResult:"Получены сведения",gmResult:"Сведения выданы",effects:[]}
    ]},
    {id:"road-collapse",title:"Обвал",description:"Дорога перекрыта",repeatable:false,actions:[
      {id:"bypass",label:"Обойти",playerResult:"Группа выбрала обходной путь",gmResult:"road_bypassed установлен",effects:[{op:"setFact",key:"road_bypassed",value:true}]}
    ]}
  ]
};
const localFile = () => ({name:"demo.json",size:400,text:async()=>JSON.stringify(demo)});

function makeWorld() {
  let nextId = 1;
  const entries = [];
  const journal = {find: fn => entries.find(fn), filter: fn => entries.filter(fn)};
  class Page {
    constructor(data) {this.type=data.type; this.text={...data.text};}
    async update(patch) {this.text.content=patch["text.content"];}
  }
  class Entry {
    constructor(data) {
      this.id=`j${nextId++}`; this.name=data.name; this.ownership=data.ownership;
      this.flags=structuredClone(data.flags ?? {});
      this.pages={contents:(data.pages ?? []).map(p => new Page(p))};
    }
    getFlag(module,key) {return this.flags[module]?.[key];}
    async delete(){const i=entries.indexOf(this);if(i!==-1)entries.splice(i,1);}
    async setFlag(module,key,value) {this.flags[module] ??= {}; this.flags[module][key]=structuredClone(value);}
    async unsetFlag(module,key) {delete this.flags[module]?.[key];}
    async createEmbeddedDocuments(type,data) {
      assert.equal(type,"JournalEntryPage");
      const pages=data.map(p=>new Page(p)); this.pages.contents.push(...pages); return pages;
    }
  }
  globalThis.JournalEntry={async create(data) {const entry = new Entry(data); entries.push(entry); return entry;}};
  const notes=[];
  const scene={
    dimensions:{sceneX:0,sceneY:0,sceneWidth:1200,sceneHeight:900},
    notes:{find: fn=> notes.find(fn), contents:notes},
    async deleteEmbeddedDocuments(type, ids){assert.equal(type,"Note");for(const id of ids){const i=notes.findIndex(n=>n.id===id);if(i!==-1)notes.splice(i,1);}},
    async createEmbeddedDocuments(type,docs) {
      assert.equal(type,"Note");
      notes.push(...docs.map(d=>({...d,id:`n${nextId++}`,getFlag:(m,k)=>d.flags[m][k]})));
    }
  };
  const users = [{id:"gm",name:"GM",active:true,isGM:true},{id:"player",name:"Player",active:true,isGM:false,character:{name:"Мира"}}];
  const notifications=[];
  globalThis.CONST={DOCUMENT_OWNERSHIP_LEVELS:{NONE:0,OBSERVER:2},JOURNAL_ENTRY_PAGE_FORMATS:{HTML:1}};
  globalThis.game={
    user:users[0],users:{get: id=>users.find(u=>u.id===id), filter: fn=>users.filter(fn)},
    journal, scenes:{contents:[scene]}, socket:{on(){},emit(){}},
  };
  globalThis.canvas={scene};
  globalThis.ui={notifications:{info: s=>notifications.push(s),warn:s=>notifications.push(s),error:s=>notifications.push(s)}};
  globalThis.ChatMessage={async create(data){return data;}};
  const exports=[];
  globalThis.foundry={utils:{saveDataToFile:(data,type,name)=>exports.push({data,type,name})}};
  return {journal,entries,scene,notes,users,notifications,exports};
}

test("GM imports a local JSON file, creates map notes and separate journals; reimport does not overwrite", async () => {
  const env=makeWorld(); const runtime=new GuildRuntime();
  await runtime.importLocalLibrary(localFile());
  assert.equal(env.entries.length,5);
  assert.equal(env.notes.length,2);
  assert.equal(runtime.storeEntry.ownership.default,0);
  assert.equal(runtime.findEntry("gm-log").ownership.default,0);
  assert.equal(runtime.findEntry("player-log").ownership.default,2);
  assert.equal(runtime.allPublicEvents.length,2);
  await runtime.importLocalLibrary(localFile());
  assert.equal(env.entries.length,5);
  assert.equal(env.notes.length,2);
});

test("invalid local JSON does not create campaign data", async () => {
  const env=makeWorld(); const runtime=new GuildRuntime();
  await runtime.importLocalLibrary({name:"broken.json",size:3,text:async()=>"{}"});
  assert.equal(env.entries.length,0);
});

test("map note placement is repeatable without changing imported data", async () => {
  const env=makeWorld(); const runtime=new GuildRuntime();
  await runtime.importLocalLibrary(localFile());
  await runtime.setupSceneNotes();
  assert.equal(env.entries.length,5);
  assert.equal(env.notes.length,2);
});

test("player choice has no effects, GM button commits and writes distinct journals", async () => {
  const env=makeWorld(); const runtime=new GuildRuntime();
  await runtime.importLocalLibrary(localFile());
  game.user=env.users[1];
  await runtime.selectAction("road-collapse","bypass");
  assert.equal(runtime.storeEntry.getFlag("guild-quest-tracker","campaign").facts.road_bypassed,false);
  assert.deepEqual(runtime.choices.player,{eventId:"road-collapse",actionId:"bypass"});
  game.user=env.users[0];
  await runtime.confirmAction("road-collapse","bypass");
  const campaign=runtime.storeEntry.getFlag("guild-quest-tracker","campaign");
  assert.equal(campaign.facts.road_bypassed,true);
  assert.equal(campaign.history.length,1);
  assert.equal(runtime.findPublicEvent("road-collapse").resolved,true);
  assert.ok(runtime.findEntry("player-log").pages.contents[0].text.content.includes("Группа выбрала обходной путь"));
  assert.ok(!runtime.findEntry("player-log").pages.contents[0].text.content.includes("road_bypassed"));
  assert.ok(runtime.findEntry("gm-log").pages.contents[0].text.content.includes("road_bypassed"));
  await runtime.confirmAction("road-collapse","bypass");
  assert.equal(runtime.storeEntry.getFlag("guild-quest-tracker","campaign").history.length,1);
});


test("settings: restart uses the original library and clears history, not module documents", async () => {
  const env=makeWorld(); const runtime=new GuildRuntime();
  await runtime.importLocalLibrary(localFile());
  await runtime.confirmAction("road-collapse","bypass");
  assert.equal(runtime.storeEntry.getFlag("guild-quest-tracker","campaign").history.length,1);
  await runtime.restartGuild({confirmed:true});
  const restored=runtime.storeEntry.getFlag("guild-quest-tracker","campaign");
  assert.equal(restored.history.length,0);
  assert.equal(restored.facts.road_bypassed,false);
  assert.equal(restored.events.find(e=>e.id==="road-collapse").resolved,false);
  assert.equal(env.notes.length,2);
  assert.equal(env.entries.length,5);
  assert.ok(runtime.findEntry("gm-log").pages.contents[0].text.content.includes("Событий пока нет"));
});

test("settings: full clear removes only our documents and map notes", async () => {
  const env=makeWorld(); const runtime=new GuildRuntime();
  await runtime.importLocalLibrary(localFile());
  const normal=await JournalEntry.create({name:"Пользовательский журнал",flags:{},ownership:{default:2}});
  await runtime.clearCampaign({confirmed:true});
  assert.equal(env.notes.length,0);
  assert.equal(env.entries.length,1);
  assert.equal(env.entries[0],normal);
  assert.equal(runtime.storeEntry,undefined);
  assert.deepEqual(runtime.choices,{});
});

test("settings: export contains complete authoritative GM progress and original library", async () => {
  const env=makeWorld(); const runtime=new GuildRuntime();
  await runtime.importLocalLibrary(localFile());
  await runtime.confirmAction("road-collapse","bypass");
  const result=runtime.exportProgress();
  assert.equal(env.exports.length,1);
  assert.equal(env.exports[0].type,"application/json");
  assert.ok(env.exports[0].name.endsWith(".json"));
  assert.equal(result.campaign.facts.road_bypassed,true);
  assert.equal(result.sourceLibrary.events.length,2);
  assert.equal(JSON.parse(env.exports[0].data).campaign.history.length,1);
});

test("settings: replacement from a different validated JSON removes old notes and resets journals", async () => {
  const env=makeWorld(); const runtime=new GuildRuntime();
  await runtime.importLocalLibrary(localFile());
  await runtime.confirmAction("road-collapse","bypass");
  const next=structuredClone(demo);
  next.events=[{id:"new-episode",title:"Новая глава",description:"Новое место",repeatable:false,actions:[{id:"go",label:"Войти",playerResult:"Вошли",gmResult:"Разрешено",effects:[]}]}];
  const file={name:"second.json",size:100,text:async()=>JSON.stringify(next)};
  await runtime.importReplacingLibrary(file,{confirmed:true});
  assert.equal(env.entries.length,4);
  assert.equal(env.notes.length,1);
  assert.equal(runtime.findPublicEvent("road-collapse"),undefined);
  assert.equal(runtime.storeEntry.getFlag("guild-quest-tracker","campaign").events[0].id,"new-episode");
  assert.equal(runtime.storeEntry.getFlag("guild-quest-tracker","campaign").history.length,0);
  assert.ok(runtime.findEntry("player-log").pages.contents[0].text.content.includes("Пока ничего"));
});

test("GM-only event never appears in public cards or player journal", async () => {
  const env=makeWorld(); const runtime=new GuildRuntime();
  const hidden=structuredClone(demo);
  hidden.events.push({id:"secret-rivals",title:"Чужой провал",description:"Секрет",visibility:"gm",repeatable:false,actions:[{id:"fail",label:"Провалились",playerResult:"не показывать",gmResult:"Результат известен ГМу",effects:[]}]});
  await runtime.importLocalLibrary({name:"hidden.json",size:200,text:async()=>JSON.stringify(hidden)});
  assert.equal(runtime.allPublicEvents.length,2);
  assert.equal(runtime.allVisibleEvents.length,3);
  assert.equal(env.notes.length,2);
  await runtime.confirmAction("secret-rivals","fail");
  assert.ok(!runtime.findEntry("player-log").pages.contents[0].text.content.includes("Чужой провал"));
  assert.ok(runtime.findEntry("gm-log").pages.contents[0].text.content.includes("Чужой провал"));
  game.user=env.users[1];
  assert.equal(runtime.findPublicEvent("secret-rivals"),undefined);
});


test("GM can export and import a saved progress file into a fresh world", async () => {
  const env=makeWorld();const rt=new GuildRuntime();
  await rt.importLocalLibrary(localFile());
  await rt.confirmAction("road-collapse","bypass");
  const backup=rt.exportProgress();
  await rt.clearCampaign({confirmed:true});
  const savedFile={name:"progress.json",size:1000,text:async()=>JSON.stringify(backup)};
  await rt.importReplacingLibrary(savedFile,{confirmed:true});
  const campaign=rt.storeEntry.getFlag("guild-quest-tracker","campaign");
  assert.equal(campaign.history.length,1);
  assert.equal(campaign.facts.road_bypassed,true);
  assert.equal(rt.findPublicEvent("road-collapse").resolved,true);
  assert.equal(env.notes.length,2);
});

test("invalid replacement never deletes an active campaign", async () => {
  const env=makeWorld();const rt=new GuildRuntime();
  await rt.importLocalLibrary(localFile());
  const invalid={...demo,events:[{...demo.events[0],actions:[{id:"bad",label:"bad",effects:[{op:"evalJS",code:"bad"}],playerResult:"",gmResult:""}]}]};
  await rt.importReplacingLibrary({name:"bad.json",size:300,text:async()=>JSON.stringify(invalid)},{confirmed:true});
  assert.equal(rt.storeEntry.getFlag("guild-quest-tracker","campaign").events.length,2);
  assert.equal(env.notes.length,2);
  assert.equal(env.entries.length,5);
});
