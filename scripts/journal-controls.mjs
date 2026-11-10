/**
 * Controls are injected into the visible native Journal sheet, without editing its
 * history text or converting informational journals to executable scripts.
 * The document's module flag, not its name, determines what we display.
 */
export function attachJournalEventControls(app, runtime) {
  const root = app?.element;
  if (!root?.querySelector || !root?.ownerDocument?.createElement) return false;
  const document = app.document ?? app.object;
  const entry = document?.documentName === "JournalEntry" ? document :
    document?.documentName === "JournalEntryPage" ? document.parent : null;
  const role = entry?.getFlag?.("guild-quest-tracker", "role");
  if (!["public-event", "player-log", "gm-log"].includes(role)) return false;
  if (root.querySelector(".gqt-journal-actions")) return false;
  const eventId = role === "public-event" ? entry.getFlag("guild-quest-tracker", "publicEvent")?.id : null;
  if (role === "public-event" && (!eventId || !runtime.findPublicEvent(eventId))) return false;

  const bar = root.ownerDocument.createElement("div");
  bar.className = "gqt-journal-actions";
  const addButton = (label, callback) => {
    const button = root.ownerDocument.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", event => {
      event.preventDefault();
      callback();
    });
    bar.append(button);
  };
  if (eventId) addButton("Открыть событие и действия", () => runtime.openEvent(eventId));
  addButton("Список событий", () => runtime.openOverview());
  // V14 JournalEntrySheet is ApplicationV2; insert after it renders, above its pages.
  const container = root.querySelector(".window-content") ?? root;
  container.prepend(bar);
  return true;
}
