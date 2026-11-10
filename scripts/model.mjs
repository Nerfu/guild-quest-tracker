/** Pure, Foundry-independent subset of the event model used by the first prototype. */
export const FORMAT_VERSION = 1;
const ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const ALLOWED_EFFECTS = new Set(["setFact", "incrementFact", "changeEventDescription", "appendEventDescription"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateLibrary(library) {
  const errors = [];
  if (!object(library) || library.formatVersion !== FORMAT_VERSION) errors.push("Неверная версия формата библиотеки.");
  if (!Array.isArray(library?.events) || library.events.length === 0) errors.push("Требуется непустой массив events.");
  if (!object(library?.facts)) errors.push("facts должен быть объектом.");
  const ids = new Set();
  for (const event of Array.isArray(library?.events) ? library.events : []) {
    if (!object(event) || !ID_RE.test(event.id ?? "") || ids.has(event.id)) {
      errors.push("Некорректный или повторяющийся ID события.");
      continue;
    }
    ids.add(event.id);
    if (event.visibility !== undefined && !["public","gm"].includes(event.visibility)) errors.push(`${event.id}: неизвестная видимость.`);
    if (typeof event.title !== "string" || !event.title.trim()) errors.push(`${event.id}: нет названия.`);
    if (typeof event.description !== "string") errors.push(`${event.id}: нет описания.`);
    if (typeof event.repeatable !== "boolean") errors.push(`${event.id}: нет признака repeatable.`);
    if (!Array.isArray(event.actions) || !event.actions.length) errors.push(`${event.id}: нет вариантов.`);
    const actionIds = new Set();
    for (const action of Array.isArray(event.actions) ? event.actions : []) {
      if (!object(action) || !ID_RE.test(action.id ?? "") || actionIds.has(action.id)) {
        errors.push(`${event.id}: повторяющийся или ошибочный ID варианта.`);
        continue;
      }
      actionIds.add(action.id);
      if (typeof action.label !== "string" || !action.label.trim()) errors.push(`${event.id}/${action.id}: нет названия.`);
      if (typeof action.playerResult !== "string" || typeof action.gmResult !== "string") errors.push(`${event.id}/${action.id}: отсутствуют тексты результатов.`);
      if (!Array.isArray(action.effects)) errors.push(`${event.id}/${action.id}: effects должен быть массивом.`);
      for (const effect of Array.isArray(action.effects) ? action.effects : []) {
        if (!object(effect) || !ALLOWED_EFFECTS.has(effect.op)) {
          errors.push(`${event.id}/${action.id}: неподдерживаемая операция.`);
          continue;
        }
        if (effect.op === "setFact" && (!ID_RE.test(effect.key ?? "") || !(typeof effect.value === "boolean" || typeof effect.value === "number" || typeof effect.value === "string"))) {
          errors.push(`${event.id}/${action.id}: ошибка setFact.`);
        }
        if (effect.op === "incrementFact" && (!ID_RE.test(effect.key ?? "") || typeof effect.amount !== "number" || !Number.isFinite(effect.amount))) {
          errors.push(`${event.id}/${action.id}: ошибка incrementFact.`);
        }
        if (["changeEventDescription","appendEventDescription"].includes(effect.op) && (!ID_RE.test(effect.eventId ?? "") || typeof effect.value !== "string" || (effect.ifResolved !== undefined && !["skip","error"].includes(effect.ifResolved)))) {
          errors.push(`${event.id}/${action.id}: ошибка changeEventDescription.`);
        }
      }
    }
  }
  for (const event of Array.isArray(library?.events) ? library.events : []) {
    for (const action of Array.isArray(event.actions) ? event.actions : []) {
      for (const effect of Array.isArray(action.effects) ? action.effects : []) {
        if (["changeEventDescription","appendEventDescription"].includes(effect.op) && !ids.has(effect.eventId)) {
          errors.push(`${event.id}/${action.id}: отсутствует событие ${effect.eventId}.`);
        }
      }
    }
  }
  return errors;
}

export function createCampaign(library) {
  const errors = validateLibrary(library);
  if (errors.length) throw new Error(errors.join("\n"));
  return {
    formatVersion: FORMAT_VERSION,
    facts: structuredClone(library.facts),
    events: structuredClone(library.events).map(e => ({...e, resolved: false})),
    history: [],
    nextSequence: 1
  };
}

/** Parse either a fresh event library or a previously exported GM-only progress snapshot. */
export function parseDataFile(data) {
  if (data?.exportFormat !== "guild-quest-tracker-progress") {
    return {campaign:createCampaign(data),library:structuredClone(data),restored:false};
  }
  if (data.exportVersion !== 1 || !object(data.campaign)) throw new Error("Неподдерживаемый формат сохранения прогресса.");
  const campaign = structuredClone(data.campaign);
  if (campaign.formatVersion !== FORMAT_VERSION || !Array.isArray(campaign.history) ||
      !Number.isSafeInteger(campaign.nextSequence) || campaign.nextSequence < 1 ||
      campaign.history.some(row => !object(row) || !Number.isSafeInteger(row.seq) ||
        typeof row.eventId !== "string" || typeof row.eventTitle !== "string" ||
        typeof row.actionId !== "string" || typeof row.actionLabel !== "string" ||
        typeof row.playerResult !== "string" || typeof row.gmResult !== "string" ||
        !Array.isArray(row.chosenBy))) {
    throw new Error("Сохранённый прогресс повреждён или имеет неизвестную структуру.");
  }
  const errors=validateLibrary({formatVersion:FORMAT_VERSION,facts:campaign.facts,events:campaign.events});
  if (errors.length) throw new Error(errors.join("\n"));
  if (campaign.events.some(event => typeof event.resolved !== "boolean")) throw new Error("В сохранении отсутствуют результаты событий.");
  if (data.sourceLibrary != null) {
    const originalErrors=validateLibrary(data.sourceLibrary);
    if (originalErrors.length) throw new Error(`Повреждена исходная библиотека в сохранении:\n${originalErrors.join("\n")}`);
  }
  return {campaign,library:data.sourceLibrary ? structuredClone(data.sourceLibrary) : null,restored:true};
}

export function publicEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    repeatable: Boolean(event.repeatable),
    resolved: Boolean(event.resolved),
    actions: (event.actions ?? []).map(a => ({id: a.id, label: a.label}))
  };
}

export function applyConfirmedAction(campaign, eventId, actionId, {gmName="Ведущий", chosenBy=[]}={}) {
  if (!object(campaign) || !Array.isArray(campaign.events)) throw new Error("Повреждены данные кампании.");
  const next = structuredClone(campaign);
  const event = next.events.find(e => e.id === eventId);
  if (!event) throw new Error("Событие не найдено.");
  if (event.resolved) throw new Error("Событие уже завершено.");
  const action = event.actions.find(a => a.id === actionId);
  if (!action) throw new Error("Вариант события недоступен.");
  for (const effect of action.effects) {
    switch (effect.op) {
      case "setFact":
        next.facts[effect.key] = effect.value;
        break;
      case "incrementFact": {
        const previous = next.facts[effect.key] ?? 0;
        if (typeof previous !== "number") throw new Error(`Факт ${effect.key} не числовой.`);
        next.facts[effect.key] = previous + effect.amount;
        break;
      }
      case "changeEventDescription":
      case "appendEventDescription": {
        const target = next.events.find(e => e.id === effect.eventId);
        if (!target) throw new Error(`Нет события ${effect.eventId}.`);
        if (target.resolved) {
          if (effect.ifResolved === "skip") break;
          throw new Error(`Нельзя изменить завершённое событие ${effect.eventId}.`);
        }
        target.description = effect.op === "appendEventDescription" ? `${target.description}\n\n${effect.value}` : effect.value;
        break;
      }
      default:
        throw new Error(`Неподдерживаемая операция ${effect.op}.`);
    }
  }
  if (!event.repeatable) event.resolved = true;
  const record = {
    seq: next.nextSequence++,
    eventId,
    eventTitle: event.title,
    actionId,
    actionLabel: action.label,
    playerResult: action.playerResult,
    gmResult: action.gmResult,
    gmName,
    chosenBy: [...chosenBy],
    hidden: event.visibility === "gm"
  };
  next.history.push(record);
  return {next, record};
}

/** Each user may have only one active event+action globally, or neither. */
export function updateChoice(choices, userId, eventId=null, actionId=null) {
  if (typeof userId !== "string" || !userId) throw new Error("Неизвестный игрок.");
  const copy = {...choices};
  if (eventId == null && actionId == null) delete copy[userId];
  else if (typeof eventId === "string" && typeof actionId === "string") copy[userId] = {eventId, actionId};
  else throw new Error("Выбор должен содержать событие и действие.");
  return copy;
}

export function removeChoicesForEvent(choices, eventId) {
  return Object.fromEntries(Object.entries(choices).filter(([,choice]) => choice.eventId !== eventId));
}
