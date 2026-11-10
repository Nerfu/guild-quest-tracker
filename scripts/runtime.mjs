import {createCampaign, parseDataFile, publicEvent, applyConfirmedAction, updateChoice, removeChoicesForEvent} from "./model.mjs";

export const MODULE_ID = "guild-quest-tracker";
const SOCKET = `module.${MODULE_ID}`;
const ROLE = "role";
const STORE = "campaign";
const PUBLIC = "publicEvent";
const ORIGINAL = "originalLibrary";
const MAX_CHOICES = 40;

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]);
}

function publicHistoryHtml(campaign) {
  const hidden = new Set(campaign.events.filter(event => event.visibility === "gm").map(event => event.id));
  const history = campaign.history.filter(record => !record.hidden && !hidden.has(record.eventId));
  return `<h2>История группы</h2>${history.length ?
    `<ol>${history.map(r => `<li><strong>${htmlEscape(r.eventTitle)}</strong> — ${htmlEscape(r.actionLabel)}. ${htmlEscape(r.playerResult)}</li>`).join("")}</ol>` :
    "<p>Пока ничего не произошло.</p>"}`;
}

function gmHistoryHtml(state) {
  const rows = state.history.map(r => `<li><strong>#${r.seq}: ${htmlEscape(r.eventTitle)}</strong> — ${htmlEscape(r.actionLabel)}<p>${htmlEscape(r.gmResult)}</p><small>Подтвердил: ${htmlEscape(r.gmName)}. Выбирали: ${htmlEscape(r.chosenBy.join(", ") || "нет")}</small></li>`).join("");
  const facts = Object.entries(state.facts).map(([key,value]) => `<li><code>${htmlEscape(key)}</code>: ${htmlEscape(JSON.stringify(value))}</li>`).join("");
  return `<h2>Факты мира</h2><ul>${facts}</ul><h2>Полная история</h2>${rows ? `<ol>${rows}</ol>` : "<p>Событий пока нет.</p>"}`;
}

function eventPublicEntryName(event) { return `ГЗ — ${event.title}`; }

export class GuildRuntime {
  constructor() {
    this.choices = {};
    this.confirming = false;
    this.setupBusy = false;
    this.eventWindow = null;
    this.overviewWindow = null;
    this.EventWindowClass = null;
    this.OverviewWindowClass = null;
  }

  attachUI(EventWindowClass, OverviewWindowClass) {
    this.EventWindowClass = EventWindowClass;
    this.OverviewWindowClass = OverviewWindowClass;
  }

  get isPrimaryGM() {
    if (!game.user?.isGM) return false;
    const active = game.users.filter(user => user.active && user.isGM)
      .sort((a,b) => a.id.localeCompare(b.id));
    return active[0]?.id === game.user.id;
  }

  get currentCharacterName() { return game.user?.character?.name || game.user?.name || "Игрок"; }

  ready() {
    game.socket.on(SOCKET, packet => this.receive(packet));
    if (game.user.isGM && this.isPrimaryGM) {
      this.repairFromStoredState().catch(err => this.showError(err));
    } else {
      this.send({type:"requestChoices"});
    }
    console.info(`[${MODULE_ID}] Прототип событий готов. Откройте инструмент «Гильдия заданий» на панели сцены.`);
  }

  send(packet) { game.socket.emit(SOCKET, packet); }

  receive(packet) {
    if (!packet || typeof packet !== "object") return;
    switch (packet.type) {
      case "choice": {
        const user = game.users.get(packet.userId);
        if (!user || user.isGM || typeof packet.eventId !== "string" || typeof packet.actionId !== "string") return;
        if (!this.allPublicEvents.find(e => e.id === packet.eventId)?.actions.some(a => a.id === packet.actionId)) return;
        this.choices = updateChoice(this.choices, user.id, packet.eventId, packet.actionId);
        this.refresh();
        break;
      }
      case "clearChoice": {
        const user = game.users.get(packet.userId);
        if (!user || user.isGM) return;
        this.choices = updateChoice(this.choices, user.id);
        this.refresh();
        break;
      }
      case "clearEvent": {
        if (typeof packet.eventId !== "string") return;
        this.choices = removeChoicesForEvent(this.choices, packet.eventId);
        this.refresh();
        break;
      }
      case "clearAllChoices": {
        this.choices = {};
        this.refresh();
        break;
      }
      case "requestChoices": {
        if (this.isPrimaryGM) this.send({type:"choicesSnapshot", choices:this.choices});
        break;
      }
      case "choicesSnapshot": {
        if (!packet.choices || typeof packet.choices !== "object") return;
        const safe = {};
        for (const [userId, choice] of Object.entries(packet.choices).slice(0, MAX_CHOICES)) {
          if (!game.users.get(userId) || typeof choice?.eventId !== "string" || typeof choice?.actionId !== "string") continue;
          if (!this.allPublicEvents.find(e => e.id === choice.eventId)?.actions.some(a => a.id === choice.actionId)) continue;
          safe[userId] = {eventId:choice.eventId, actionId:choice.actionId};
        }
        this.choices = safe;
        this.refresh();
        break;
      }
      default: break;
    }
  }

  findEntry(role) { return game.journal.find(j => j.getFlag(MODULE_ID, ROLE) === role); }

  get storeEntry() { return this.findEntry("storage"); }
  get allVisibleEvents() {
    if (!game.user?.isGM) return this.allPublicEvents;
    const stored = this.storeEntry?.getFlag(MODULE_ID, STORE);
    if (!stored?.events) return this.allPublicEvents;
    const pub = new Map(this.allPublicEvents.map(event => [event.id, event]));
    return stored.events.map(event => event.visibility === "gm" ? publicEvent(event) : (pub.get(event.id) ?? publicEvent(event)));
  }
  get allPublicEvents() {
    return game.journal.filter(entry => entry.getFlag(MODULE_ID, ROLE) === "public-event")
      .map(entry => entry.getFlag(MODULE_ID, PUBLIC))
      .filter(e => e && typeof e.id === "string");
  }
  findPublicEvent(eventId) {
    if (game.user?.isGM) return this.allVisibleEvents.find(e => e.id === eventId);
    return this.allPublicEvents.find(e => e.id === eventId);
  }

  playerChoicesFor(eventId, actionId) {
    return Object.entries(this.choices)
      .filter(([,choice]) => choice.eventId === eventId && choice.actionId === actionId)
      .map(([id]) => game.users.get(id))
      .filter(Boolean)
      .map(user => user.character?.name || user.name);
  }

  async selectAction(eventId, actionId) {
    if (game.user.isGM) return this.confirmAction(eventId, actionId);
    const event = this.findPublicEvent(eventId);
    if (!event || event.resolved || !event.actions.some(a => a.id === actionId)) {
      ui.notifications.warn("Это действие больше не доступно.");
      return;
    }
    this.choices = updateChoice(this.choices, game.user.id, eventId, actionId);
    this.send({type:"choice", userId:game.user.id, eventId, actionId});
    this.refresh();
  }

  clearMyChoice() {
    if (game.user.isGM) return;
    this.choices = updateChoice(this.choices, game.user.id);
    this.send({type:"clearChoice", userId:game.user.id});
    this.refresh();
  }

  async confirmAction(eventId, actionId) {
    if (!this.isPrimaryGM) {
      ui.notifications.warn("Подтверждение доступно активному ведущему.");
      return;
    }
    if (this.confirming) return;
    this.confirming = true;
    try {
      const store = this.storeEntry;
      if (!store) throw new Error("Демонстрация не настроена. Сначала создайте её через инструмент гильдии.");
      const current = store.getFlag(MODULE_ID, STORE);
      const {next,record} = applyConfirmedAction(current, eventId, actionId, {
        gmName: game.user.name,
        chosenBy: this.playerChoicesFor(eventId, actionId)
      });
      // The hidden GM-only document is the authoritative state.
      await store.setFlag(MODULE_ID, STORE, next);
      // Journal and public-note projections may be rebuilt if this step fails.
      await this.syncProjections(next);
      this.choices = removeChoicesForEvent(this.choices, eventId);
      this.send({type:"clearEvent", eventId});
      this.refresh();
      ui.notifications.info(`Событие исполнено: ${record.eventTitle} — ${record.actionLabel}`);
    } catch (err) {
      this.showError(err);
    } finally {
      this.confirming = false;
    }
  }

  /** Open the operating system's local file chooser. The JSON never lives in the module folder. */
  chooseLocalLibrary() {
    if (!this.isPrimaryGM) {
      ui.notifications.warn("Импорт библиотеки доступен активному ведущему.");
      return;
    }
    const chooser = document.createElement("input");
    chooser.type = "file";
    chooser.accept = ".json,application/json";
    chooser.addEventListener("change", () => {
      const file = chooser.files?.[0];
      if (file) void this.importLocalLibrary(file);
    }, {once:true});
    chooser.click();
  }

  /** Initial import of a local file, not an update/patch. Never overwrite live campaign data. */
  async importLocalLibrary(file) {
    if (!this.isPrimaryGM) {
      ui.notifications.warn("Импорт библиотеки доступен активному ведущему.");
      return;
    }
    if (this.setupBusy) return;
    if (this.storeEntry) {
      ui.notifications.warn("Библиотека уже импортирована. Обновления и патчи появятся в следующем этапе; существующий мир не перезаписываем.");
      return;
    }
    if (!file || typeof file.text !== "function" || !String(file.name ?? "").toLowerCase().endsWith(".json")) {
      ui.notifications.warn("Выберите JSON-файл с локального компьютера.");
      return;
    }
    // Prototype bound to prevent accidental import of enormous / unrelated files.
    if (file.size > 5 * 1024 * 1024) {
      ui.notifications.warn("Для прототипа максимальный размер библиотеки — 5 МБ.");
      return;
    }
    this.setupBusy = true;
    try {
      const {library,campaign,restored} = parseDataFile(JSON.parse(await file.text())); // Validate before any writes.
      if (this.storeEntry) throw new Error("Данные кампании уже существуют.");
      const store = await JournalEntry.create({
        name:"ГЗ — служебные данные (только ведущий)",
        ownership:{default:CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE},
        flags:{[MODULE_ID]:{[ROLE]:"storage",[STORE]:campaign,[ORIGINAL]:library}}
      });
      if (!store) throw new Error("Не удалось создать хранилище.");
      await this.ensureJournals();
      for (const event of campaign.events) if (event.visibility !== "gm") await this.ensurePublicEntry(event);
      await this.syncProjections(campaign);
      if (canvas?.scene) await this.ensureSceneNotes(canvas.scene,campaign.events.filter(e => e.visibility !== "gm"));
      this.refresh();
      ui.notifications.info(restored ? "Прогресс восстановлен из локального JSON-файла." : `Импортировано событий: ${campaign.events.length}. Исходный JSON остаётся на вашем компьютере.`);
    } catch (err) {
      this.showError(err);
    } finally {
      this.setupBusy = false;
    }
  }

  /** Add missing Note links to the currently active scene; safe to call again. */
  async setupSceneNotes() {
    if (!this.isPrimaryGM) {
      ui.notifications.warn("Размещение меток доступно активному ведущему.");
      return;
    }
    if (this.setupBusy) return;
    const scene = canvas?.scene;
    if (!scene) {
      ui.notifications.warn("Откройте сцену, на которой нужно разместить метки.");
      return;
    }
    const campaign = this.storeEntry?.getFlag(MODULE_ID,STORE);
    if (!campaign) {
      ui.notifications.warn("Сначала импортируйте локальную JSON-библиотеку.");
      return;
    }
    this.setupBusy = true;
    try {
      for (const event of campaign.events) if (event.visibility !== "gm") await this.ensurePublicEntry(event);
      await this.ensureSceneNotes(scene,campaign.events.filter(e => e.visibility !== "gm"));
      await this.syncProjections(campaign);
      this.refresh();
      ui.notifications.info("Отсутствующие метки событий добавлены на текущую сцену.");
    } catch (err) {
      this.showError(err);
    } finally {
      this.setupBusy = false;
    }
  }

  async ensureJournals() {
    const defs = [
      {role:"player-log", name:"ГЗ — журнал игроков", ownership:{default:CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER}},
      {role:"gm-log", name:"ГЗ — журнал ведущего", ownership:{default:CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE}}
    ];
    for (const def of defs) {
      if (this.findEntry(def.role)) continue;
      await JournalEntry.create({
        name:def.name,
        ownership:def.ownership,
        flags:{[MODULE_ID]:{[ROLE]:def.role}},
        pages:[{name:"История", type:"text",text:{content:"<p>Пока ничего не произошло.</p>",format:CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML}}]
      });
    }
  }

  async ensurePublicEntry(event) {
    if (event.visibility === "gm") return null;
    let entry = game.journal.find(j => j.getFlag(MODULE_ID, ROLE) === "public-event" && j.getFlag(MODULE_ID, PUBLIC)?.id === event.id);
    if (entry) return entry;
    entry = await JournalEntry.create({
      name:eventPublicEntryName(event),
      ownership:{default:CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER},
      flags:{[MODULE_ID]:{[ROLE]:"public-event",[PUBLIC]:publicEvent(event)}},
      pages:[{name:"Описание",type:"text",text:{content:`<p>${htmlEscape(event.description)}</p>`,format:CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML}}]
    });
    if (!entry) throw new Error(`Не удалось создать точку события ${event.id}.`);
    return entry;
  }

  async ensureSceneNotes(scene, events) {
    const size = scene.dimensions;
    const startY = size.sceneY ?? 0;
    const height = size.sceneHeight ?? size.height ?? 1000;
    const startX = size.sceneX ?? 0;
    const width = size.sceneWidth ?? size.width ?? 1000;
    for (let index=0; index<events.length; index++) {
      const event = events[index];
      const existing = scene.notes.find(note => note.getFlag(MODULE_ID, "eventId") === event.id);
      if (existing) continue;
      const entry = game.journal.find(j => j.getFlag(MODULE_ID, ROLE)==="public-event" && j.getFlag(MODULE_ID, PUBLIC)?.id===event.id);
      if (!entry) continue;
      await scene.createEmbeddedDocuments("Note", [{
        entryId: entry.id,
        x: startX + width * (0.15 + 0.22 * (index % 4)),
        y: startY + height * Math.min(0.3 + 0.22 * Math.floor(index / 4), 0.92),
        text: event.title,
        iconSize: 44,
        texture:{src:"icons/svg/book.svg"},
        flags:{[MODULE_ID]:{eventId:event.id}}
      }]);
    }
  }

  async syncProjections(campaign) {
    // A crash between committing state and updating UI projections is recoverable.
    await this.ensureJournals();
    for (const role of ["player-log", "gm-log"]) {
      const doc = this.findEntry(role);
      if (!doc) continue;
      let page = doc.pages.contents.find(p => p.type === "text");
      if (!page) {
        const pages = await doc.createEmbeddedDocuments("JournalEntryPage", [{name:"История",type:"text",text:{content:"<p></p>",format:CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML}}]);
        page = pages[0];
      }
      const html = role === "player-log" ? publicHistoryHtml(campaign) : gmHistoryHtml(campaign);
      if (page.text?.content !== html) await page.update({"text.content":html});
    }
    for (const event of campaign.events) {
      if (event.visibility === "gm") continue;
      const entry = game.journal.find(j => j.getFlag(MODULE_ID,ROLE)==="public-event" && j.getFlag(MODULE_ID,PUBLIC)?.id===event.id);
      if (!entry) continue;
      const data = publicEvent(event);
      if (JSON.stringify(entry.getFlag(MODULE_ID,PUBLIC)) !== JSON.stringify(data)) await entry.setFlag(MODULE_ID,PUBLIC,data);
      // Keep the ordinary public Journal sheet consistent with our custom event window.
      const page = entry.pages.contents.find(p => p.type === "text");
      const descriptionHtml = `<p>${htmlEscape(event.description)}</p>`;
      if (page && page.text?.content !== descriptionHtml) await page.update({"text.content":descriptionHtml});
    }
  }

  async repairFromStoredState() {
    const campaign = this.storeEntry?.getFlag(MODULE_ID,STORE);
    if (!campaign) return;
    for (const event of campaign.events) if (event.visibility !== "gm") await this.ensurePublicEntry(event);
    await this.syncProjections(campaign);
    if (canvas?.scene) await this.ensureSceneNotes(canvas.scene,campaign.events.filter(e=>e.visibility!=="gm"));
  }

  openEvent(eventId) {
    const event = this.findPublicEvent(eventId);
    if (!event) {
      ui.notifications.warn("Событие недоступно.");
      return;
    }
    if (!this.eventWindow) this.eventWindow = new this.EventWindowClass(this);
    this.eventWindow.eventId = eventId;
    this.eventWindow.render({force:true});
  }

  openOverview() {
    if (!this.overviewWindow) this.overviewWindow = new this.OverviewWindowClass(this);
    this.overviewWindow.render({force:true});
  }

  refresh() {
    if (this.eventWindow?.rendered) this.eventWindow.render();
    if (this.overviewWindow?.rendered) this.overviewWindow.render();
  }

  /** World-owned scene notes, including notes on scenes not currently open. */
  get ownedSceneNotes() {
    const scenes = new Set(game.scenes?.contents ?? []);
    if (canvas?.scene) scenes.add(canvas.scene);
    return [...scenes].map(scene => ({
      scene,
      ids:(scene.notes?.contents ?? (typeof scene.notes?.values === "function" ? [...scene.notes.values()] : [])).filter(note =>
        Boolean(note.getFlag?.(MODULE_ID,"eventId"))).map(note => note.id).filter(Boolean)
    })).filter(group => group.ids.length);
  }

  clearAllChoices() {
    this.choices = {};
    this.send({type:"clearAllChoices"});
    this.refresh();
  }

  async deleteOwnedNotes() {
    for (const {scene, ids} of this.ownedSceneNotes) await scene.deleteEmbeddedDocuments("Note", ids);
  }

  /** Deletes only documents and notes tagged as owned by this module. */
  async clearCampaign({confirmed=false}={}) {
    if (!this.isPrimaryGM) return ui.notifications.warn("Только ведущий может очищать данные.");
    if (this.setupBusy || this.confirming) return;
    if (!confirmed && !(await this.confirmDestructive("Удалить все данные гильдии?", "Будут удалены события, история, журналы и метки модуля на всех сценах. Это нельзя отменить. Сначала сохраните прогресс в файл."))) return;
    this.setupBusy = true;
    try {
      await this.deleteOwnedNotes();
      const docs = game.journal.filter(entry => ["storage","player-log","gm-log","public-event"].includes(entry.getFlag(MODULE_ID,ROLE)));
      for (const doc of docs) await doc.delete();
      this.clearAllChoices();
      this.refresh();
      ui.notifications.info("Данные гильдии удалены из текущего мира.");
    } catch (err) {this.showError(err);}
    finally {this.setupBusy = false;}
  }

  /** Reset campaign to original imported JSON, not to a patched or currently changed event snapshot. */
  async restartGuild({confirmed=false}={}) {
    if (!this.isPrimaryGM) return ui.notifications.warn("Только ведущий может перезапустить гильдию.");
    if (this.setupBusy || this.confirming) return;
    const store = this.storeEntry;
    const original = store?.getFlag(MODULE_ID,ORIGINAL);
    if (!original) return ui.notifications.warn("Оригинальная библиотека не сохранена (старый импорт). Выберите исходный JSON через «Импорт».");
    if (!confirmed && !(await this.confirmDestructive("Запустить гильдию заново?", "Выполненные события, факты и оба журнала вернутся к исходному состоянию импортированной библиотеки. Метки останутся."))) return;
    this.setupBusy = true;
    try {
      const next = createCampaign(original);
      await store.setFlag(MODULE_ID,STORE,next);
      await this.syncProjections(next);
      this.clearAllChoices();
      this.refresh();
      ui.notifications.info("Гильдия запущена заново из исходной библиотеки.");
    } catch (err) {this.showError(err);}
    finally {this.setupBusy = false;}
  }

  async confirmDestructive(title, message) {
    return Boolean(await foundry.applications.api.DialogV2.confirm({
      window:{title}, content:`<p>${htmlEscape(message)}</p>`,modal:true,rejectClose:false,
      yes:{label:"Подтвердить"},no:{label:"Отмена"}
    }));
  }

  /** The current campaign and original definitions, never just the public journal. */
  exportProgress() {
    if (!this.isPrimaryGM) return ui.notifications.warn("Сохранение прогресса доступно только ведущему.");
    const store=this.storeEntry;
    if (!store) return ui.notifications.warn("В мире пока нет импортированной кампании.");
    const payload = {
      exportFormat:"guild-quest-tracker-progress",exportVersion:1,
      moduleVersion:game.modules?.get(MODULE_ID)?.version ?? "0.1.2",
      campaign:store.getFlag(MODULE_ID,STORE),
      sourceLibrary:store.getFlag(MODULE_ID,ORIGINAL) ?? null
    };
    const filename=`guild-quest-progress-${new Date().toISOString().slice(0,10)}.json`;
    foundry.utils.saveDataToFile(JSON.stringify(payload,null,2),"application/json",filename);
    ui.notifications.info("Прогресс сохранён в локальный JSON-файл. Скрытые сведения ведущего включены.");
    return payload;
  }

  /** Choose a local file; validates before asking to replace an active campaign. */
  chooseReplacementLibrary() {
    if (!this.isPrimaryGM) return ui.notifications.warn("Только ведущий может импортировать библиотеку.");
    const picker=document.createElement("input");
    picker.type="file";picker.accept=".json,application/json";
    picker.addEventListener("change",()=>{if(picker.files?.[0]) void this.importReplacingLibrary(picker.files[0]);},{once:true});
    picker.click();
  }

  async importReplacingLibrary(file, {confirmed=false}={}) {
    if (!this.isPrimaryGM) return ui.notifications.warn("Импорт доступен только ведущему.");
    if (this.setupBusy || this.confirming) return;
    if (!file || typeof file.text!=="function" || !String(file.name??"").toLowerCase().endsWith(".json") || file.size>5*1024*1024) {
      return ui.notifications.warn("Нужен JSON-файл не больше 5 МБ.");
    }
    let library, next, restored;
    try {
      ({library,campaign:next,restored}=parseDataFile(JSON.parse(await file.text())));
    } catch(err) {return this.showError(err);}
    const store=this.storeEntry;
    if (!store) return this.importLocalLibrary(file);
    if (!confirmed && !(await this.confirmDestructive("Заменить импортированную библиотеку?", "Текущая кампания будет заменена данными выбранного JSON. Поддерживаются новая библиотека и файл сохранённого прогресса. Это не импорт патча."))) return;
    this.setupBusy=true;
    const previousCampaign=store.getFlag(MODULE_ID,STORE);
    const previousLibrary=store.getFlag(MODULE_ID,ORIGINAL);
    try {
      // Store the new state before changing projections; if the latter fails, startup repair can resume.
      await store.setFlag(MODULE_ID,ORIGINAL,library);
      await store.setFlag(MODULE_ID,STORE,next);
      await this.deleteOwnedNotes();
      for (const doc of game.journal.filter(j=>j.getFlag(MODULE_ID,ROLE)==="public-event")) await doc.delete();
      for (const event of next.events) if (event.visibility !== "gm") await this.ensurePublicEntry(event);
      await this.syncProjections(next);
      if (canvas?.scene) await this.ensureSceneNotes(canvas.scene,next.events.filter(e=>e.visibility!=="gm"));
      this.clearAllChoices();
      this.refresh();
      ui.notifications.info(restored ? "Сохранённая кампания восстановлена из файла." : `Новая библиотека загружена: ${next.events.length} событий. Прогресс начат заново.`);
    } catch(err) {
      // If a change fails after publishing the new state, restore the prior authoritative values.
      try {
        await store.setFlag(MODULE_ID,STORE,previousCampaign);
        if (previousLibrary) await store.setFlag(MODULE_ID,ORIGINAL,previousLibrary);
        else await store.unsetFlag(MODULE_ID,ORIGINAL);
        await this.repairFromStoredState();
      } catch(restoreError) {console.error(`[${MODULE_ID}] Не удалось восстановить проекции:`,restoreError);}
      this.showError(err);
    } finally {this.setupBusy=false;}
  }

  async reportSelections() {
    if (!game.user.isGM) return;
    const rows = Object.entries(this.choices).map(([userId,choice]) => {
      const user = game.users.get(userId);
      const event = this.findPublicEvent(choice.eventId);
      const action = event?.actions.find(a => a.id === choice.actionId);
      if (!user || !event || !action) return null;
      return `<li><strong>${htmlEscape(user.character?.name || user.name)}</strong>: ${htmlEscape(event.title)} — ${htmlEscape(action.label)}</li>`;
    }).filter(Boolean);
    const absent = game.users.filter(u => u.active && !u.isGM && !this.choices[u.id]);
    const noChoice = absent.length ? `<p><small>Без выбора: ${absent.map(u => htmlEscape(u.character?.name || u.name)).join(", ")}</small></p>` : "";
    const html = `<h3>Текущие выборы группы</h3>${rows.length?`<ul>${rows.join("")}</ul>`:"<p>Нет выбранных действий.</p>"}${noChoice}<p><em>Это только намерения игроков; события не исполнены.</em></p>`;
    await ChatMessage.create({speaker:{alias:"Гильдия заданий"},content:html,whisper:game.users.filter(u=>u.isGM).map(u=>u.id)});
  }

  showError(err) {
    console.error(`[${MODULE_ID}]`,err);
    ui.notifications.error(`Гильдия заданий: ${err?.message || err}`);
  }
}
