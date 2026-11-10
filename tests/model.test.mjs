import test from "node:test";
import assert from "node:assert/strict";
import {validateLibrary, createCampaign, publicEvent, applyConfirmedAction, updateChoice, removeChoicesForEvent, parseDataFile} from "../scripts/model.mjs";
// Synthetic JS fixture for tests, not the external quest/event JSON library.
const library = {
  formatVersion:1,
  facts:{road_open:false,guild_actions:0},
  events:[
    {id:"guild-visit",title:"Гильдия",description:"Обзор",repeatable:true,actions:[
      {id:"personal-quests",label:"Спросить",playerResult:"Новости",gmResult:"Новости получены",effects:[{op:"incrementFact",key:"guild_actions",amount:1}]},
      {id:"notice-board",label:"Доска",playerResult:"Объявления",gmResult:"Доска просмотрена",effects:[{op:"incrementFact",key:"guild_actions",amount:1}]}
    ]},
    {id:"road-collapse",title:"Обвал",description:"Закрыто",repeatable:false,actions:[
      {id:"clear-road",label:"Расчистить",playerResult:"Дорога открыта",gmResult:"Открыта",effects:[{op:"setFact",key:"road_open",value:true}]},
      {id:"bypass",label:"Обойти",playerResult:"Обход",gmResult:"Обход",effects:[]}
    ]}
  ]
};

test("demo library validates and keeps IDs unique", () => {
  assert.deepEqual(validateLibrary(library), []);
  const bad = structuredClone(library);
  bad.events.push(structuredClone(bad.events[0]));
  assert.ok(validateLibrary(bad).length > 0);
});

test("player view excludes effects and GM-only text", () => {
  const event = publicEvent(createCampaign(library).events[0]);
  assert.equal(event.id, "guild-visit");
  assert.equal(JSON.stringify(event).includes("gmResult"), false);
  assert.equal(JSON.stringify(event).includes("effects"), false);
});

test("GM confirms action; result updates facts and history once", () => {
  const original = createCampaign(library);
  const {next, record} = applyConfirmedAction(original, "road-collapse", "clear-road", {gmName:"GM", chosenBy:["Alice"]});
  assert.equal(original.facts.road_open, false);
  assert.equal(next.facts.road_open, true);
  assert.equal(record.chosenBy[0], "Alice");
  assert.equal(next.history.length, 1);
  assert.throws(() => applyConfirmedAction(next, "road-collapse", "clear-road"), /завершено/);
});

test("repeatable event may be confirmed again, maintaining history", () => {
  let state = createCampaign(library);
  state = applyConfirmedAction(state, "guild-visit", "personal-quests").next;
  state = applyConfirmedAction(state, "guild-visit", "notice-board").next;
  assert.equal(state.facts.guild_actions, 2);
  assert.equal(state.history.length, 2);
});

test("each real player has one global selection and can clear it", () => {
  let choices = {};
  choices = updateChoice(choices, "alice", "guild-visit", "personal-quests");
  choices = updateChoice(choices, "bob", "road-collapse", "bypass");
  choices = updateChoice(choices, "alice", "road-collapse", "clear-road");
  assert.equal(Object.keys(choices).length, 2);
  assert.deepEqual(choices.alice, {eventId:"road-collapse", actionId:"clear-road"});
  choices = removeChoicesForEvent(choices, "road-collapse");
  assert.equal(Object.keys(choices).length, 0);
  choices = updateChoice(choices, "bob", "guild-visit", "notice-board");
  choices = updateChoice(choices, "bob");
  assert.equal(Object.keys(choices).length, 0);
});

test("an effect can change a future active event directly", () => {
  const extra = structuredClone(library);
  extra.events[0].actions[0].effects.push({op:"changeEventDescription",eventId:"road-collapse",value:"Теперь завал известен."});
  assert.deepEqual(validateLibrary(extra), []);
  const state = applyConfirmedAction(createCampaign(extra), "guild-visit", "personal-quests").next;
  assert.equal(state.events[1].description, "Теперь завал известен.");
});


test("event lore can append directly to active event; resolved target can be skipped", () => {
  const lib=structuredClone(library);
  lib.events[0].actions[0].effects.push({op:"appendEventDescription",eventId:"road-collapse",value:"Прибыло подкрепление.",ifResolved:"skip"});
  assert.deepEqual(validateLibrary(lib),[]);
  let state=applyConfirmedAction(createCampaign(lib),"guild-visit","personal-quests").next;
  assert.match(state.events.find(e=>e.id==="road-collapse").description,/Прибыло подкрепление/);
  state=applyConfirmedAction(state,"road-collapse","bypass").next;
  state=applyConfirmedAction(state,"guild-visit","personal-quests").next;
  assert.equal(state.history.length,3);
});


test("progress export can round-trip without replaying effects", () => {
  const original=createCampaign(library);
  const changed=applyConfirmedAction(original,"road-collapse","clear-road").next;
  const data={exportFormat:"guild-quest-tracker-progress",exportVersion:1,campaign:changed,sourceLibrary:library};
  const loaded=parseDataFile(JSON.parse(JSON.stringify(data)));
  assert.equal(loaded.restored,true);
  assert.equal(loaded.campaign.facts.road_open,true);
  assert.equal(loaded.campaign.history.length,1);
  assert.equal(loaded.library.events.length,2);
  assert.throws(()=>applyConfirmedAction(loaded.campaign,"road-collapse","clear-road"),/завершено/);
});

test("new JSON is interpreted as a fresh library, not a progress export", () => {
  const result=parseDataFile(library);
  assert.equal(result.restored,false);
  assert.equal(result.campaign.history.length,0);
});
