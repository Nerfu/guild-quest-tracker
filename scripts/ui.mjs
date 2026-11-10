const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;
const BASE_PATH = "modules/guild-quest-tracker";

export class GuildEventWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(runtime) {
    super();
    this.runtime = runtime;
    this.eventId = null;
  }

  static DEFAULT_OPTIONS = {
    id: "gqt-event-window",
    classes: ["gqt-app"],
    window: {title:"Гильдия заданий — событие", resizable:true},
    position: {width:520},
    actions: {
      choose: GuildEventWindow.onChoose,
      clear: GuildEventWindow.onClear,
      overview: GuildEventWindow.onOverview
    }
  };

  static PARTS = {body:{template:`${BASE_PATH}/templates/event.hbs`}};

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const event = this.runtime.findPublicEvent(this.eventId);
    const choice = this.runtime.choices[game.user.id];
    return {
      ...context,
      title:event?.title ?? "Событие недоступно",
      description:event?.description ?? "",
      resolved: Boolean(event?.resolved),
      isGM:game.user.isGM,
      isPrimaryGM:this.runtime.isPrimaryGM,
      hasOwnChoice: Boolean(choice),
      actions: (event?.actions ?? []).map(action => ({
        id: action.id,
        label: action.label,
        mine: choice?.eventId === this.eventId && choice?.actionId === action.id,
        names: this.runtime.playerChoicesFor(this.eventId, action.id)
      }))
    };
  }

  static async onChoose(_event,target) {
    await this.runtime.selectAction(this.eventId,target.dataset.choiceId);
  }
  static onClear() { this.runtime.clearMyChoice(); }
  static onOverview() { this.runtime.openOverview(); }
}

export class GuildOverviewWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(runtime) {
    super();
    this.runtime = runtime;
  }

  static DEFAULT_OPTIONS = {
    id:"gqt-overview-window",
    classes:["gqt-app"],
    window:{title:"Гильдия заданий — обзор",resizable:true},
    position:{width:480},
    actions:{
      open: GuildOverviewWindow.onOpen,
      import: GuildOverviewWindow.onImport,
      notes: GuildOverviewWindow.onNotes,
      report: GuildOverviewWindow.onReport,
      clear: GuildOverviewWindow.onClear,
      manage: GuildOverviewWindow.onManage
    }
  };

  static PARTS = {body:{template:`${BASE_PATH}/templates/overview.hbs`}};

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const choice = this.runtime.choices[game.user.id];
    return {
      ...context,
      isGM: game.user.isGM,
      isPrimaryGM: this.runtime.isPrimaryGM,
      hasOwnChoice: Boolean(choice),
      isSetUp: Boolean(this.runtime.allVisibleEvents.length),
      events: this.runtime.allVisibleEvents.map(e => ({
        id:e.id,title:e.title,description:e.description,
        resolved:e.resolved,
        selectedCount:Object.values(this.runtime.choices).filter(c => c.eventId === e.id).length
      }))
    };
  }

  static onOpen(_event,target) { this.runtime.openEvent(target.dataset.eventId); }
  static onImport() { this.runtime.chooseLocalLibrary(); }
  static async onNotes() { await this.runtime.setupSceneNotes(); }
  static async onReport() { await this.runtime.reportSelections(); }
  static onClear() { this.runtime.clearMyChoice(); }
  static onManage() { new GuildAdminWindow().render({force:true}); }
}

/** Settings submenu registered through the public Foundry v14 ClientSettings API. */
export class GuildAdminWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static runtime = null;
  constructor(...args) {
    super(...args);
    this.runtime = GuildAdminWindow.runtime;
  }
  static DEFAULT_OPTIONS = {
    id:"gqt-admin-window",
    classes:["gqt-app"],
    window:{title:"Гильдия заданий — экспорт и импорт JSON",resizable:true},
    position:{width:540},
    actions:{
      import:GuildAdminWindow.onImport,
      export:GuildAdminWindow.onExport,
      restart:GuildAdminWindow.onRestart,
      clear:GuildAdminWindow.onClear
    }
  };
  static PARTS={body:{template:`${BASE_PATH}/templates/admin.hbs`}};
  async _prepareContext(options) {
    return {
      ...await super._prepareContext(options),
      hasCampaign:Boolean(this.runtime?.storeEntry),
      canRestart:Boolean(this.runtime?.storeEntry?.getFlag("guild-quest-tracker","originalLibrary")),
      isPrimaryGM:Boolean(this.runtime?.isPrimaryGM)
    };
  }
  static onImport(){this.runtime.chooseReplacementLibrary();}
  static onExport(){this.runtime.exportProgress();}
  static async onRestart(){await this.runtime.restartGuild();}
  static async onClear(){await this.runtime.clearCampaign();}
}
