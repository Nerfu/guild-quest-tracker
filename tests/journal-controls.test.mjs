import test from "node:test";
import assert from "node:assert/strict";
import {attachJournalEventControls} from "../scripts/journal-controls.mjs";

function fixture(role, id="quest-1") {
  const actions=[]; const inserted=[]; const listeners={};
  const ownerDocument={createElement(tag) {
    const el={tag,className:"",type:"",textContent:"",children:[],append(child){this.children.push(child);},
      addEventListener(event,handler){listeners[this.textContent]=handler;}};
    return el;
  }};
  const root={ownerDocument,querySelector(sel){return sel===".window-content"? {prepend(el){inserted.push(el);}} : null;}};
  const entry={documentName:"JournalEntry",getFlag(module,key){assert.equal(module,"guild-quest-tracker");
    return key==="role" ? role : key==="publicEvent"? {id}:undefined;}};
  const runtime={findPublicEvent:i=>i===id?{id}:null,openEvent:i=>actions.push(["event",i]),openOverview:()=>actions.push(["overview"])};
  return {app:{element:root,document:entry},inserted,actions,listeners,runtime};
}

test("public journal sheet shows an event action and an overview action",()=>{
  const x=fixture("public-event");
  assert.equal(attachJournalEventControls(x.app,x.runtime),true);
  assert.equal(x.inserted[0].children.length,2);
  x.listeners["Открыть событие и действия"]({preventDefault(){}});
  x.listeners["Список событий"]({preventDefault(){}});
  assert.deepEqual(x.actions,[["event","quest-1"],["overview"]]);
});

test("player and GM history journals offer a safe overview link, never an outcome action",()=>{
  for(const role of ["player-log","gm-log"]) {
    const x=fixture(role);
    assert.equal(attachJournalEventControls(x.app,x.runtime),true);
    assert.deepEqual(x.inserted[0].children.map(c=>c.textContent),["Список событий"]);
  }
});

test("unrelated journal sheets and missing events never gain module controls",()=>{
  const x=fixture("custom");
  assert.equal(attachJournalEventControls(x.app,x.runtime),false);
  assert.equal(x.inserted.length,0);
  const y=fixture("public-event");y.runtime.findPublicEvent=()=>null;
  assert.equal(attachJournalEventControls(y.app,y.runtime),false);
});
