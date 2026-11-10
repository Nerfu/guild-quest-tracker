import {GuildRuntime} from "./scripts/runtime.mjs";
import {GuildEventWindow, GuildOverviewWindow, GuildAdminWindow} from "./scripts/ui.mjs";
import {attachJournalEventControls} from "./scripts/journal-controls.mjs";

const runtime = new GuildRuntime();
runtime.attachUI(GuildEventWindow, GuildOverviewWindow, GuildAdminWindow);
GuildAdminWindow.runtime = runtime;
GuildOverviewWindow.runtime = runtime;

// Register the menu before Foundry renders Configure Settings.
Hooks.once("init", () => {
  game.settings.registerMenu("guild-quest-tracker", "events", {
    name:"События и задания",
    label:"Открыть список событий",
    hint:"Просмотр доступных заданий и выбор действий; игроки могут открывать события самостоятельно.",
    icon:"fa-solid fa-book-open",
    type:GuildOverviewWindow,
    restricted:false
  });
  game.settings.registerMenu("guild-quest-tracker", "jsonImportExport", {
    name:"Экспорт и импорт JSON",
    label:"Экспорт и импорт JSON",
    hint:"Импорт библиотеки, экспорт прогресса, перезапуск и очистка данных гильдии.",
    icon:"fa-solid fa-file-arrow-down",
    type:GuildAdminWindow,
    restricted:true
  });
});

// Foundry v14 scene toolbar. Available to players and GMs, without modifying RPG sheets.
Hooks.on("getSceneControlButtons", controls => {
  // These tools belong next to Foundry's map notes, not hidden in Token tools.
  const host = controls.notes ?? controls.tokens;
  if (!host?.tools) return;
  const order = Object.keys(host.tools).length;
  host.tools.gqtOverview = {
    name:"gqtOverview",title:"Гильдия заданий: события",icon:"fa-solid fa-book-open",
    order:order+1,button:true,visible:true,onChange:() => runtime.openOverview()
  };
  if (game.user?.isGM) {
    host.tools.gqtImport = {
      name:"gqtImport",title:"Гильдия заданий: импорт JSON с компьютера",icon:"fa-solid fa-file-import",
      order:order+2,button:true,visible:true,onChange:() => runtime.chooseLocalLibrary()
    };
    host.tools.gqtNotes = {
      name:"gqtNotes",title:"Гильдия заданий: поставить метки событий на сцену",icon:"fa-solid fa-map-location-dot",
      order:order+3,button:true,visible:true,onChange:() => runtime.setupSceneNotes()
    };
    host.tools.gqtReport = {
      name:"gqtReport",title:"Гильдия заданий: отчёт о выборах в чат",icon:"fa-solid fa-list-check",
      order:order+4,button:true,visible:true,onChange:() => runtime.reportSelections()
    };
  }
});

// Give module-created journal entries a direct, visible entry point into the event UI.
Hooks.on("renderApplicationV2", app => {
  attachJournalEventControls(app, runtime);
});

// Intercept only our own journal-linked map notes. Other notes behave normally.
Hooks.on("activateNote", note => {
  const eventId = note.document?.getFlag("guild-quest-tracker","eventId");
  if (!eventId) return;
  runtime.openEvent(eventId);
  return false;
});

Hooks.on("updateJournalEntry", entry => {
  if (entry.getFlag("guild-quest-tracker","role") === "public-event") runtime.refresh();
});
Hooks.on("createJournalEntry", entry => {
  if (entry.getFlag("guild-quest-tracker","role") === "public-event") runtime.refresh();
});

Hooks.once("ready", () => {
  // Macro / console access for older UI configurations or quick tests.
  game.guildQuestTracker = Object.freeze({
    open: () => runtime.openOverview(),
    openEvent: id => runtime.openEvent(id),
    importLibrary: () => runtime.chooseLocalLibrary(),
    placeNotes: () => runtime.setupSceneNotes(),
    reportSelections: () => runtime.reportSelections(),
    clearSelection: () => runtime.clearMyChoice(),
    manageData: () => new GuildAdminWindow().render({force:true}),
    importNewLibrary: () => runtime.chooseReplacementLibrary(),
    exportProgress: () => runtime.exportProgress(),
    restartGuild: () => runtime.restartGuild(),
    clearData: () => runtime.clearCampaign()
  });
  runtime.ready();
});
