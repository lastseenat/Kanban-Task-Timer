const { Modal, Notice, Plugin, setIcon, normalizePath } = require("obsidian");

const CONTROL_CLASS = "kanban-task-timer";
const CARD_SELECTOR = ".kanban-plugin__item-wrapper";
const LANE_SELECTOR = ".kanban-plugin__lane";
const LANE_TOGGLE_CLASS = "kanban-task-timer-lane-toggle";
const LANE_MOVE_ALL_CLASS = "kanban-task-timer-lane-move-all";
const LANE_TOTAL_CLASS = "kanban-task-timer-lane-total";
const LANE_HIDDEN_CLASS = "kanban-task-timer-lane-hidden";
const SUMMARY_CLASS = "kanban-task-timer-summary";
const DELETE_CLASS = "kanban-task-timer-delete";
const ESTIMATE_CLASS = "kanban-task-timer-estimate";
const FORCED_START_COMPACT_CLASS = "kanban-task-timer-forced-start-compact";
const FORCED_WARNING_CLASS = "kanban-task-timer-forced-warning";
const FORCED_START_LABEL_CLASS = "kanban-task-timer-forced-start-label";
const MOBILE_RESET_CLASS = "kanban-task-timer-mobile-reset";
const SUBLIST_FOLDER = "Sous-listes";
const SUBLIST_ALIAS = "Sous-tâches";
const BOARD_ROOT_SELECTOR = ".kanban-plugin";
const BOARD_SELECTOR = ".kanban-plugin__board";
const DEFAULT_HIDDEN_LANE = "autre jour";
const TODO_LANE = "à faire";
const LATER_LANE = "plus tard";
const DONE_LANES = new Set(["terminé", "terminées", "fait", "faits", "done", "archive"]);
const DURATION_PATTERN = /(?:—|–|-)\s*(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?!\d)/;
const WIKI_LINK_PATTERN = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const FILE_SETTLE_DELAY = 2000;
const SUBLIST_MARKER_PATTERN = /^kanban-task-timer-sublist:\s*true\s*$/m;

function canonicalLaneTitle(value) {
  return String(value || "")
    .toLocaleLowerCase()
    .replace(/Ã©|Ã¨|Ãª|Ã«/g, "e")
    .replace(/Ã€|Ã‚|Ã„/g, "a")
    .replace(/[ÃÂ][€©ª]/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

module.exports = class KanbanTaskTimerPlugin extends Plugin {
  async onload() {
    this.removeControls();

    const saved = await this.loadData();
    this.store = {
      version: 2,
      timers: saved?.timers && typeof saved.timers === "object" ? saved.timers : {},
      hiddenLanes:
        saved?.hiddenLanes && typeof saved.hiddenLanes === "object" ? saved.hiddenLanes : {},
      sleepPlans:
        saved?.sleepPlans && typeof saved.sleepPlans === "object" ? saved.sleepPlans : {},
      forcedStarts:
        saved?.forcedStarts && typeof saved.forcedStarts === "object" ? saved.forcedStarts : {},
    };

    this.renderQueued = false;
    this.saveQueued = null;
    this.boardTasks = new Map();
    this.boardTaskLoads = new Map();
    this.parentSyncQueued = new Map();
    this.sublistDurationSyncQueued = new Map();
    this.cardDurationSyncQueued = new Map();
    this.fileProcessQueues = new Map();
    this.fileModifiedAt = new Map();
    this.pendingCheckpointWrites = new Map();
    this.pendingCheckpointDurations = new Map();
    this.resetRequests = new WeakSet();

    // Kanban temporarily replaces a card while it is being dropped. Capture
    // reset clicks here so the first click after a move is never lost.
    this.globalResetHandler = (event) => {
      const target = event.target;
      const resetButton =
        target instanceof Element
          ? target.closest(`.${CONTROL_CLASS}__reset`)
          : null;
      if (!resetButton) return;

      const controls = resetButton.closest(`.${CONTROL_CLASS}`);
      if (!controls) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.requestResetControlsTimer(controls);
    };
    document.addEventListener("click", this.globalResetHandler, true);
    this.register(() =>
      document.removeEventListener("click", this.globalResetHandler, true)
    );

    this.observer = new MutationObserver(() => this.queueRender());
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.register(() => this.observer.disconnect());

    this.registerEvent(this.app.workspace.on("layout-change", () => this.queueRender()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.queueRender()));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.extension !== "md") return;
        this.fileModifiedAt.set(file.path, Date.now());
        this.boardTasks.delete(file.path);
        if (file.path.startsWith(`${SUBLIST_FOLDER}/`)) {
          this.queueSublistDurationSync(file.path);
          this.queueParentDurationSync(file.path);
        } else {
          this.queueCardDurationSync(file.path);
        }
        this.queueRender();
      })
    );

    this.registerInterval(
      window.setInterval(() => {
        this.updateVisibleTimers();
      }, 250)
    );

    this.register(() => {
      this.removeControls();
    });

    this.queueRender();
    void this.ensureExistingSubtaskDurations();
  }

  onunload() {
    this.removeControls();

    if (this.saveQueued) {
      window.clearTimeout(this.saveQueued);
      this.saveQueued = null;
    }
    for (const timeoutId of this.parentSyncQueued.values()) {
      window.clearTimeout(timeoutId);
    }
    this.parentSyncQueued.clear();
    for (const timeoutId of this.sublistDurationSyncQueued.values()) {
      window.clearTimeout(timeoutId);
    }
    this.sublistDurationSyncQueued.clear();
    for (const timeoutId of this.cardDurationSyncQueued.values()) {
      window.clearTimeout(timeoutId);
    }
    this.cardDurationSyncQueued.clear();
    this.pendingCheckpointWrites.clear();
    this.pendingCheckpointDurations.clear();
    void this.saveData(this.store);
  }

  removeControls() {
    document.querySelectorAll(`.${CONTROL_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`.${DELETE_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`.${ESTIMATE_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`.${FORCED_START_COMPACT_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`.${FORCED_WARNING_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`.${FORCED_START_LABEL_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`.${MOBILE_RESET_CLASS}`).forEach((element) => element.remove());
    document
      .querySelectorAll(`.${DELETE_CLASS}-container`)
      .forEach((element) => element.classList.remove(`${DELETE_CLASS}-container`));
    document.querySelectorAll(`.${LANE_TOGGLE_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`.${LANE_MOVE_ALL_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`.${LANE_TOTAL_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`.${SUMMARY_CLASS}`).forEach((element) => element.remove());
    document
      .querySelectorAll(`.${LANE_HIDDEN_CLASS}`)
      .forEach((element) => element.classList.remove(LANE_HIDDEN_CLASS));
  }

  queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    window.requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderAllCards();
    });
  }

  renderAllCards() {
    this.renderLaneToggles();
    this.renderLaneMoveButtons();
    this.renderLaneTotals();

    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
    const occurrencesByView = new WeakMap();

    for (const card of cards) {
      this.ensureDeleteButton(card);
      const details = this.readCard(card) || this.readCardLoose(card);
      if (!details) {
        card.querySelector(`:scope > .${CONTROL_CLASS}`)?.remove();
        continue;
      }

      const viewContainer = card.closest(".workspace-leaf") || card.ownerDocument;
      let occurrences = occurrencesByView.get(viewContainer);
      if (!occurrences) {
        occurrences = new Map();
        occurrencesByView.set(viewContainer, occurrences);
      }

      const boardPath = this.getBoardPath(card);
      const baseKey = `${boardPath}::${details.stableText}`;
      const occurrence = (occurrences.get(baseKey) || 0) + 1;
      occurrences.set(baseKey, occurrence);
      const key = `${baseKey}::${occurrence}`;
      const laneTitle = (
        card.closest(LANE_SELECTOR)?.querySelector(".kanban-plugin__lane-title-text")
          ?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase();
      if (laneTitle === "autre jour") {
        this.clearForcedStartsForCard(boardPath, details.stableText);
      }
      const sublistPath = details.sublistLink
        ? this.resolveLinkedPath(details.sublistLink, boardPath)
        : "";
      this.renderForcedStartLabel(card, key);

      if (sublistPath) {
        void this.ensureBoardTasks(sublistPath);
      }

      if (card.closest(LANE_SELECTOR)?.classList.contains(LANE_HIDDEN_CLASS)) {
        card.querySelector(`:scope > .${CONTROL_CLASS}`)?.remove();
        this.renderCompactForcedStart(card, key);
        this.renderCardEstimate(card, { ...details, key });
        if (!sublistPath) this.getTimer(key, details.durationMs);
        continue;
      }

      this.renderCardEstimate(card, { ...details, key });
      card.querySelector(`.${FORCED_START_COMPACT_CLASS}`)?.remove();
      this.renderCardTimer(card, {
        key,
        boardPath,
        stableText: details.stableText,
        occurrence,
        durationMs: details.durationMs,
        taskTitle: details.taskTitle,
        sublistPath,
      });
    }

    this.updateCardForcedWarnings();
    this.renderSummaries();
  }

  renderCardEstimate(card, details) {
    let bubble = card.querySelector(`.${ESTIMATE_CLASS}`);
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = ESTIMATE_CLASS;
      bubble.setAttribute("role", "status");
      bubble.hidden = true;
      card.appendChild(bubble);
      card.addEventListener("mouseenter", () => {
        const targetDetails = this.readCard(card) || this.readCardLoose(card);
        if (!targetDetails) return;
        const lane = card.closest(LANE_SELECTOR);
        const precedingCards = lane
          ? Array.from(lane.querySelectorAll(CARD_SELECTOR)).slice(
              0,
              Array.from(lane.querySelectorAll(CARD_SELECTOR)).indexOf(card)
            )
          : [];
        const elapsedBefore = precedingCards.reduce((total, precedingCard) => {
          const precedingDetails =
            this.readCard(precedingCard) || this.readCardLoose(precedingCard);
          return total + (precedingDetails?.durationMs || 0);
        }, 0);
        const estimatedStart = new Date(Date.now() + elapsedBefore);
        const time = estimatedStart.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const currentKey = card.querySelector(`.${CONTROL_CLASS}`)?.dataset.timerKey || details.key;
        const forcedStart = currentKey ? this.store.forcedStarts[currentKey] : "";
        const forcedMatch = String(forcedStart || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
        const estimatedMinutes = estimatedStart.getHours() * 60 + estimatedStart.getMinutes();
        const forcedMinutes = forcedMatch
          ? Number(forcedMatch[1]) * 60 + Number(forcedMatch[2])
          : null;
    const warning = forcedMinutes !== null && estimatedMinutes > forcedMinutes ? " !" : "";
        bubble.textContent = `Début estimé : ${time}${warning}`;
        bubble.title = forcedMatch
          ? `Début imposé : ${forcedStart}${warning ? " — début estimé trop tard" : ""}`
          : "";
        bubble.textContent = `D\u00e9but estim\u00e9 : ${time}`;
        bubble.title = forcedMatch
          ? `D\u00e9but impos\u00e9 : ${forcedStart}${warning ? " - d\u00e9but estim\u00e9 trop tard" : ""}`
          : "";
        bubble.hidden = false;
        bubble.classList.add("is-visible");
      });
      card.addEventListener("mouseleave", () => {
        bubble.hidden = true;
        bubble.classList.remove("is-visible");
      });
    }
  }

  clearForcedStartsForCard(boardPath, stableText) {
    const prefix = `${boardPath}::${stableText}::`;
    let changed = false;
    for (const key of Object.keys(this.store.forcedStarts)) {
      if (!key.startsWith(prefix)) continue;
      delete this.store.forcedStarts[key];
      changed = true;
    }
    if (changed) this.queueSave(true);
  }

  renderForcedStartLabel(card, key) {
    let label = card.querySelector(`.${FORCED_START_LABEL_CLASS}`);
    const forcedStart = this.store.forcedStarts[key] || "";
    if (!forcedStart) {
      label?.remove();
      return;
    }

    if (!label) {
      label = document.createElement("div");
      label.className = FORCED_START_LABEL_CLASS;
      const labelHost =
        card.querySelector(".kanban-plugin__item-title") ||
        card.querySelector(".kanban-plugin__item-content-wrapper") ||
        card;
      labelHost.appendChild(label);
    }
    label.dataset.timerKey = key;
    label.textContent = forcedStart;
  }

  renderLaneToggles() {
    const lanes = Array.from(document.querySelectorAll(LANE_SELECTOR));
    const occurrencesByView = new WeakMap();

    for (const lane of lanes) {
      const titleElement = lane.querySelector(".kanban-plugin__lane-title-text");
      const laneTitle = (titleElement?.textContent || "").replace(/\s+/g, " ").trim();
      if (!laneTitle) continue;

      const normalizedTitle = laneTitle.toLocaleLowerCase();
      const viewContainer = lane.closest(".workspace-leaf") || lane.ownerDocument;
      let occurrences = occurrencesByView.get(viewContainer);
      if (!occurrences) {
        occurrences = new Map();
        occurrencesByView.set(viewContainer, occurrences);
      }

      const boardPath = this.getBoardPath(lane);
      const baseKey = `${boardPath}::${normalizedTitle}`;
      const occurrence = (occurrences.get(baseKey) || 0) + 1;
      occurrences.set(baseKey, occurrence);
      const laneKey = `${baseKey}::${occurrence}`;
      const storedVisibility = this.store.hiddenLanes[laneKey];
      const hidden =
        typeof storedVisibility === "boolean"
          ? storedVisibility
          : normalizedTitle === DEFAULT_HIDDEN_LANE;

      lane.classList.toggle(LANE_HIDDEN_CLASS, hidden);

      let button = lane.querySelector(`.${LANE_TOGGLE_CLASS}`);
      if (!button) {
        button = document.createElement("button");
        button.className = `${LANE_TOGGLE_CLASS} clickable-icon`;
        button.type = "button";

        for (const eventName of ["pointerdown", "mousedown", "touchstart"]) {
          button.addEventListener(eventName, (event) => event.stopPropagation());
        }

        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();

          const key = button.dataset.laneKey;
          if (!key) return;

          this.store.hiddenLanes[key] = button.dataset.hidden !== "true";
          this.queueSave(true);
          this.queueRender();
        });

        const header = lane.querySelector(":scope > .kanban-plugin__lane-header-wrapper");
        const settings = header?.querySelector(".kanban-plugin__lane-settings-button-wrapper");
        if (settings?.parentElement) {
          settings.parentElement.insertBefore(button, settings);
        } else {
          header?.appendChild(button);
        }
      }

      const nextHiddenValue = String(hidden);
      if (button.dataset.hidden !== nextHiddenValue) {
        setIcon(button, hidden ? "eye-off" : "eye");
      }

      button.dataset.laneKey = laneKey;
      button.dataset.hidden = nextHiddenValue;
      button.classList.toggle("is-hidden", hidden);
      const label = hidden
        ? "Afficher les minuteurs de cette colonne"
        : "Masquer les minuteurs de cette colonne";
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
  }

  renderLaneMoveButtons() {
    const lanes = Array.from(document.querySelectorAll(LANE_SELECTOR));
    for (const lane of lanes) {
      const header = lane.querySelector(":scope > .kanban-plugin__lane-header-wrapper");
      if (!header) continue;

      let button = header.querySelector(`.${LANE_MOVE_ALL_CLASS}`);
      if (!button) {
        button = document.createElement("button");
        button.className = `${LANE_MOVE_ALL_CLASS} clickable-icon`;
        button.type = "button";
        button.addEventListener("pointerdown", (event) => event.stopPropagation());
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.showMoveAllMenu(lane, event);
        });

        const settings = header.querySelector(".kanban-plugin__lane-settings-button-wrapper");
        if (settings?.parentElement) settings.parentElement.insertBefore(button, settings);
        else header.appendChild(button);
      }

      setIcon(button, "arrow-right-left");
      button.setAttribute("aria-label", "Déplacer toutes les cartes");
      button.setAttribute("title", "Déplacer toutes les cartes");
    }
  }

  showMoveAllMenu(sourceLane, event) {
    const sourceTitle = (
      sourceLane.querySelector(".kanban-plugin__lane-title-text")?.textContent || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const board = sourceLane.closest(BOARD_SELECTOR) || document;
    const targets = Array.from(board.querySelectorAll(LANE_SELECTOR)).filter(
      (lane) => lane !== sourceLane
    );
    if (!sourceTitle || targets.length === 0) return;

    const modal = new Modal(this.app);
    modal.titleEl.setText("Déplacer toutes les cartes");
    modal.onOpen = () => {
      const { contentEl } = modal;
      contentEl.createEl("p", {
        text: `Choisir la colonne de destination pour les cartes de « ${sourceTitle} »`,
      });
      const choices = contentEl.createDiv({ cls: "kanban-task-timer-move-all-choices" });
      for (const targetLane of targets) {
        const targetTitle = (
          targetLane.querySelector(".kanban-plugin__lane-title-text")?.textContent || ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (!targetTitle) continue;
        const choice = choices.createEl("button", { text: `Vers « ${targetTitle} »` });
        choice.addEventListener("click", () => {
          modal.close();
          void this.moveAllCards(sourceLane, targetLane);
        });
      }
    };
    modal.open();
  }

  async moveAllCards(sourceLane, targetLane) {
    const boardPath = this.app.workspace.getActiveFile()?.path || this.getBoardPath(sourceLane);
    if (!boardPath || boardPath === "kanban") {
      new Notice("Impossible d'identifier le fichier Kanban actif");
      return;
    }

    // Use the rendered lane order instead of comparing heading text. Some
    // existing boards contain legacy mojibake in accented headings, while
    // Obsidian may render the same heading differently in the DOM.
    const board = sourceLane.closest(BOARD_SELECTOR) || document;
    const renderedLanes = Array.from(board.querySelectorAll(LANE_SELECTOR));
    const sourceLaneIndex = renderedLanes.indexOf(sourceLane);
    const targetLaneIndex = renderedLanes.indexOf(targetLane);
    if (sourceLaneIndex < 0 || targetLaneIndex < 0 || sourceLaneIndex === targetLaneIndex) {
      return;
    }

    const sourceTitle = (
      sourceLane.querySelector(".kanban-plugin__lane-title-text")?.textContent || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const targetTitle = (
      targetLane.querySelector(".kanban-plugin__lane-title-text")?.textContent || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!sourceTitle || !targetTitle) return;

    const cardPattern = /^- (?:\[[ xX]\] )?/;
    let movedCount = 0;
    await this.processFile(boardPath, (content) => {
      const lines = content.split(/\r?\n/);
      const sections = [];
      for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/^##\s+(.+?)\s*$/);
        if (!match) continue;
        sections.push({ title: match[1].trim(), start: index });
      }

      const sourceKey = canonicalLaneTitle(sourceTitle);
      const targetKey = canonicalLaneTitle(targetTitle);
      const source = sections.find((section) => canonicalLaneTitle(section.title) === sourceKey) || sections[sourceLaneIndex];
      const target = sections.find((section) => canonicalLaneTitle(section.title) === targetKey) || sections[targetLaneIndex];
      if (!source || !target || source === target) return content;

      const sectionEnd = (section) => {
        const next = sections.find((candidate) => candidate.start > section.start);
        return next ? next.start : lines.length;
      };
      const sourceEnd = sectionEnd(source);
      const targetEnd = sectionEnd(target);
      const sourceLines = lines.slice(source.start + 1, sourceEnd);
      const cards = sourceLines.filter((line) => cardPattern.test(line));
      if (cards.length === 0) return content;
      movedCount = cards.length;

      const withoutCards = new Set(
        sourceLines
          .map((line, index) => (cardPattern.test(line) ? index : -1))
          .filter((index) => index >= 0)
      );
      const nextLines = lines.filter((line, index) => {
        if (index <= source.start || index >= sourceEnd) return true;
        return !withoutCards.has(index - source.start - 1);
      });

      const targetHeadingIndex = nextLines.findIndex(
        (line) => line.match(/^##\s+(.+?)\s*$/)?.[1].trim().toLocaleLowerCase() === targetTitle.toLocaleLowerCase()
      );
      if (targetHeadingIndex < 0) return content;
      let insertAt = targetHeadingIndex + 1;
      while (insertAt < nextLines.length && nextLines[insertAt].trim() === "") insertAt += 1;
      nextLines.splice(insertAt, 0, ...cards, "");
      return `${nextLines.join("\n").replace(/\n+$/, "")}\n`;
    });

    if (movedCount === 0) {
      new Notice(`Aucune carte à déplacer depuis « ${sourceTitle} »`);
      return;
    }
    new Notice(`${movedCount} carte${movedCount > 1 ? "s" : ""} déplacée${movedCount > 1 ? "s" : ""} vers « ${targetTitle} »`);
    this.queueRender();
  }

  renderLaneTotals(now = Date.now()) {
    for (const lane of document.querySelectorAll(LANE_SELECTOR)) {
      const laneTitle = (
        lane.querySelector(".kanban-plugin__lane-title-text")?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase();
      let total = lane.querySelector(`.${LANE_TOTAL_CLASS}`);

      if (laneTitle !== TODO_LANE && laneTitle !== LATER_LANE) {
        total?.remove();
        continue;
      }

      const root = lane.closest(BOARD_ROOT_SELECTOR);
      if (!root) continue;
      const totals = this.calculateRemainingByLane(root, now);
      const durationMs = laneTitle === TODO_LANE ? totals.todoMs : totals.laterMs;

      if (!total) {
        total = document.createElement("div");
        total.className = LANE_TOTAL_CLASS;
        const items = lane.querySelector(".kanban-plugin__lane-items") || lane;
        items.appendChild(total);
      }

      const label = laneTitle === TODO_LANE ? "Total à faire" : "Total plus tard";
      const value = this.formatCompactDuration(durationMs);
      if (total.textContent !== `${label} ${value}`) {
        total.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
      }
    }
  }

  renderSummaries() {
    const roots = Array.from(document.querySelectorAll(BOARD_ROOT_SELECTOR));

    for (const root of roots) {
      const board = root.querySelector(`:scope > ${BOARD_SELECTOR}`);
      const lanes = root.querySelectorAll(LANE_SELECTOR);
      let summary = root.querySelector(`:scope > .${SUMMARY_CLASS}`);

      if (!board || lanes.length === 0) {
        summary?.remove();
        continue;
      }

      if (!summary) {
        summary = document.createElement("div");
        summary.className = SUMMARY_CLASS;
        summary.innerHTML = `
          <div class="${SUMMARY_CLASS}__item ${SUMMARY_CLASS}__item--now">
            <div class="${SUMMARY_CLASS}__metric">
              <span class="${SUMMARY_CLASS}__label">Maintenant</span>
              <strong class="${SUMMARY_CLASS}__value" data-summary-value="now"></strong>
              <span class="${SUMMARY_CLASS}__forced-warning" hidden>
                <span class="${SUMMARY_CLASS}__forced-warning-icon"></span>
                <strong class="${SUMMARY_CLASS}__forced-warning-time"></strong>
              </span>
            </div>
            <div class="${SUMMARY_CLASS}__metric ${SUMMARY_CLASS}__metric--bedtime">
              <span class="${SUMMARY_CLASS}__label">Heure de coucher</span>
              <strong class="${SUMMARY_CLASS}__value" data-summary-value="bedtime">—</strong>
            </div>
          </div>
          <div class="${SUMMARY_CLASS}__item ${SUMMARY_CLASS}__item--todo">
            <span class="${SUMMARY_CLASS}__label">Fin À faire</span>
            <strong class="${SUMMARY_CLASS}__value" data-summary-value="todo"></strong>
          </div>
          <div class="${SUMMARY_CLASS}__item ${SUMMARY_CLASS}__item--all">
            <span class="${SUMMARY_CLASS}__label">Fin avec Plus tard</span>
            <strong class="${SUMMARY_CLASS}__value" data-summary-value="all"></strong>
          </div>
          <div class="${SUMMARY_CLASS}__sleep" hidden>
            <label class="${SUMMARY_CLASS}__sleep-field">
              <span>Heures de sommeil requises</span>
              <input
                class="${SUMMARY_CLASS}__sleep-duration"
                type="text"
                inputmode="numeric"
                placeholder="08:00"
                aria-label="Heures de sommeil requises"
              >
            </label>
            <label class="${SUMMARY_CLASS}__sleep-field">
              <span>Heure de lever</span>
              <input
                class="${SUMMARY_CLASS}__sleep-wake"
                type="time"
                aria-label="Heure de lever"
              >
            </label>
          </div>
        `;
        for (const input of summary.querySelectorAll(
          `.${SUMMARY_CLASS}__sleep-duration, .${SUMMARY_CLASS}__sleep-wake`
        )) {
          input.addEventListener("input", () => this.saveSleepPlan(summary));
          input.addEventListener("change", () => this.saveSleepPlan(summary));
        }
        setIcon(
          summary.querySelector(`.${SUMMARY_CLASS}__forced-warning-icon`),
          "triangle-alert"
        );
        root.insertBefore(summary, board);
      }

      const boardPath = this.getBoardPath(root);
      summary.dataset.boardPath = boardPath;
      void this.ensureBoardTasks(boardPath);
      this.updateSummary(summary, root);
    }
  }

  updateSummaries(now = Date.now()) {
    document.querySelectorAll(`.${SUMMARY_CLASS}`).forEach((summary) => {
      const root = summary.closest(BOARD_ROOT_SELECTOR);
      if (root) this.updateSummary(summary, root, now);
    });
  }

  updateSummary(summary, root, now = Date.now()) {
    const totals = this.calculateRemainingByLane(root, now);
    const todoFinish = now + totals.todoMs;
    const allFinish = todoFinish + totals.laterMs;
    const boardPath = summary.dataset.boardPath || this.getBoardPath(root);
    const sleepPlanner = summary.querySelector(`.${SUMMARY_CLASS}__sleep`);
    const bedtimeMetric = summary.querySelector(`.${SUMMARY_CLASS}__metric--bedtime`);
    const hasSleepPlanner =
      boardPath === normalizePath("Tableau de tâches.md");

    if (sleepPlanner) sleepPlanner.hidden = !hasSleepPlanner;
    if (bedtimeMetric) bedtimeMetric.hidden = !hasSleepPlanner;
    if (hasSleepPlanner) {
      this.updateSleepPlan(summary, boardPath);
      this.updateBedtimeStatus(
        summary,
        boardPath,
        todoFinish,
        allFinish,
        now
      );
    }

    this.setSummaryValue(summary, "now", this.formatClockTime(now, now));
    this.updateForcedStartWarning(summary, root, now);
    this.setSummaryValue(summary, "todo", this.formatClockTime(todoFinish, now));
    this.setSummaryValue(summary, "all", this.formatClockTime(allFinish, now));

    const todoItem = summary.querySelector('[data-summary-value="todo"]')?.parentElement;
    const allItem = summary.querySelector('[data-summary-value="all"]')?.parentElement;
    const todoDuration = this.formatCompactDuration(totals.todoMs);
    const allDuration = this.formatCompactDuration(totals.todoMs + totals.laterMs);

    if (todoItem) {
      todoItem.title = `Durée restante dans À faire : ${todoDuration}`;
    }
    if (allItem) {
      allItem.title = `Durée restante dans À faire et Plus tard : ${allDuration}`;
    }
  }

  updateForcedStartWarning(summary, root, now = Date.now()) {
    const warningElement = summary.querySelector(
      `.${SUMMARY_CLASS}__forced-warning`
    );
    const warningTime = summary.querySelector(
      `.${SUMMARY_CLASS}__forced-warning-time`
    );
    const warningIcon = summary.querySelector(
      `.${SUMMARY_CLASS}__forced-warning-icon`
    );
    if (!warningElement) return;

    const forcedTasks = [];
    const lateTasks = [];
    for (const lane of root.querySelectorAll(LANE_SELECTOR)) {
      const laneTitle = (
        lane.querySelector(".kanban-plugin__lane-title-text")?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase();
      let elapsedBefore = 0;
      for (const card of lane.querySelectorAll(CARD_SELECTOR)) {
        const details = this.readCard(card) || this.readCardLoose(card);
        if (!details) continue;
        const key =
          card.querySelector(`.${CONTROL_CLASS}`)?.dataset.timerKey ||
          card.querySelector(`.${FORCED_START_COMPACT_CLASS}`)?.dataset.timerKey ||
          "";
        const forcedStart = key ? this.store.forcedStarts[key] : "";
        const forcedMatch = String(forcedStart || "").match(
          /^([01]\d|2[0-3]):([0-5]\d)$/
        );
        if (forcedMatch && !DONE_LANES.has(laneTitle)) {
          const estimatedStart = new Date(now + elapsedBefore);
          const estimatedMinutes =
            estimatedStart.getHours() * 60 + estimatedStart.getMinutes();
          const forcedMinutes =
            Number(forcedMatch[1]) * 60 + Number(forcedMatch[2]);
          const task = {
            title: details.taskTitle || details.stableText,
            forcedMinutes,
          };
          forcedTasks.push(task);
          if (estimatedMinutes > forcedMinutes) lateTasks.push(task);
        }
        elapsedBefore += details.durationMs || 0;
      }
    }

    warningElement.hidden = forcedTasks.length === 0;
    warningElement.classList.toggle("is-late", lateTasks.length > 0);
    if (warningIcon) warningIcon.hidden = lateTasks.length === 0;
    warningElement.title = lateTasks.length
      ? `Horaire impose depasse : ${lateTasks.map((task) => task.title).join(", ")}`
      : "";
    if (warningTime) {
      if (!forcedTasks.length) {
        warningTime.textContent = "";
      } else {
        const currentDate = new Date(now);
        const currentMinutes =
          currentDate.getHours() * 60 + currentDate.getMinutes();
        const targetTask = lateTasks[0] || forcedTasks[0];
        const minutesRemaining = targetTask.forcedMinutes - currentMinutes;
        warningTime.textContent =
          minutesRemaining >= 0
            ? `${minutesRemaining} min`
            : `${Math.abs(minutesRemaining)} min de retard`;
      }
    }
  }

  updateCardForcedWarnings(now = Date.now()) {
    for (const root of document.querySelectorAll(BOARD_ROOT_SELECTOR)) {
      for (const lane of root.querySelectorAll(LANE_SELECTOR)) {
        const laneTitle = (
          lane.querySelector(".kanban-plugin__lane-title-text")?.textContent || ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLocaleLowerCase();
        let elapsedBefore = 0;

        for (const card of lane.querySelectorAll(CARD_SELECTOR)) {
          const details = this.readCard(card) || this.readCardLoose(card);
          if (!details) continue;
          const key =
            card.querySelector(`.${CONTROL_CLASS}`)?.dataset.timerKey ||
            card.querySelector(`.${FORCED_START_COMPACT_CLASS}`)?.dataset.timerKey ||
            "";
          const forcedStart = key ? this.store.forcedStarts[key] : "";
          const forcedMatch = String(forcedStart || "").match(
            /^([01]\d|2[0-3]):([0-5]\d)$/
          );
          let isLate = false;
          if (forcedMatch && !DONE_LANES.has(laneTitle)) {
            const estimatedStart = new Date(now + elapsedBefore);
            const estimatedMinutes =
              estimatedStart.getHours() * 60 + estimatedStart.getMinutes();
            const forcedMinutes =
              Number(forcedMatch[1]) * 60 + Number(forcedMatch[2]);
            isLate = estimatedMinutes > forcedMinutes;
          }

          let warningElement = card.querySelector(`.${FORCED_WARNING_CLASS}`);
          if (isLate && !warningElement) {
            warningElement = document.createElement("span");
            warningElement.className = FORCED_WARNING_CLASS;
            warningElement.setAttribute("aria-label", "Horaire impose depasse");
            setIcon(warningElement, "triangle-alert");
            const host =
              card.querySelector(".kanban-plugin__item-postfix-button-wrapper") || card;
            const actionGroup = host.parentElement && host !== card ? host.parentElement : host;
            actionGroup.insertBefore(warningElement, host === card ? host.firstChild : host);
          }
          if (warningElement) {
            const host =
              card.querySelector(".kanban-plugin__item-postfix-button-wrapper") || card;
            const actionGroup = host.parentElement && host !== card ? host.parentElement : host;
            if (warningElement.parentElement !== actionGroup) {
              actionGroup.insertBefore(warningElement, host === card ? host.firstChild : host);
            }
            warningElement.hidden = !isLate;
            warningElement.title = isLate
              ? `Debut estime apres ${forcedStart}`
              : "";
          }
          card
            .querySelector(`.${FORCED_START_LABEL_CLASS}`)
            ?.classList.toggle("is-late", isLate);

          elapsedBefore += details.durationMs || 0;
        }
      }
    }
  }

  saveSleepPlan(summary) {
    const boardPath = summary?.dataset.boardPath;
    if (!boardPath) return;

    this.store.sleepPlans[boardPath] = {
      duration:
        summary.querySelector(`.${SUMMARY_CLASS}__sleep-duration`)?.value.trim() || "",
      wake: summary.querySelector(`.${SUMMARY_CLASS}__sleep-wake`)?.value || "",
    };
    this.queueSave(true);
    this.updateSleepPlan(summary, boardPath);
  }

  updateSleepPlan(summary, boardPath) {
    const plan = this.store.sleepPlans[boardPath] || {};
    const durationInput = summary.querySelector(`.${SUMMARY_CLASS}__sleep-duration`);
    const wakeInput = summary.querySelector(`.${SUMMARY_CLASS}__sleep-wake`);

    if (durationInput && durationInput.value !== (plan.duration || "")) {
      durationInput.value = plan.duration || "";
    }
    if (wakeInput && wakeInput.value !== (plan.wake || "")) {
      wakeInput.value = plan.wake || "";
    }

    const durationMinutes = this.parseSleepDuration(plan.duration);
    const wakeMatch = String(plan.wake || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    let bedtime = "—";
    if (durationMinutes !== null && wakeMatch) {
      const wakeMinutes = Number(wakeMatch[1]) * 60 + Number(wakeMatch[2]);
      const bedtimeMinutes = (wakeMinutes - durationMinutes + 1440 * 2) % 1440;
      bedtime = `${String(Math.floor(bedtimeMinutes / 60)).padStart(2, "0")}:${String(
        bedtimeMinutes % 60
      ).padStart(2, "0")}`;
    }
    this.setSummaryValue(summary, "bedtime", bedtime);
  }

  updateBedtimeStatus(summary, boardPath, todoFinish, allFinish, now = Date.now()) {
    const metric = summary.querySelector(`.${SUMMARY_CLASS}__metric--bedtime`);
    const todoItem = summary.querySelector(`.${SUMMARY_CLASS}__item--todo`);
    const allItem = summary.querySelector(`.${SUMMARY_CLASS}__item--all`);
    if (!metric) return;

    metric.classList.remove("is-safe", "is-warning", "is-overdue");
    metric.removeAttribute("title");
    todoItem?.classList.remove("is-after-bedtime", "is-before-bedtime");
    allItem?.classList.remove("is-after-bedtime", "is-before-bedtime");

    const plan = this.store.sleepPlans[boardPath] || {};
    const durationMinutes = this.parseSleepDuration(plan.duration);
    const wakeMatch = String(plan.wake || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (durationMinutes === null || !wakeMatch) return;

    const wakeMinutes = Number(wakeMatch[1]) * 60 + Number(wakeMatch[2]);
    const bedtimeMinutes = (wakeMinutes - durationMinutes + 1440 * 2) % 1440;
    const date = new Date(now);
    const currentMinutes = date.getHours() * 60 + date.getMinutes();
    const bedtime = new Date(date);
    bedtime.setHours(
      Math.floor(bedtimeMinutes / 60),
      bedtimeMinutes % 60,
      0,
      0
    );
    if (currentMinutes < wakeMinutes) {
      bedtime.setDate(bedtime.getDate() - 1);
    }

    const bedtimeTimestamp = bedtime.getTime();
    const todoLate = todoFinish > bedtimeTimestamp;
    const allLate = allFinish > bedtimeTimestamp;
    todoItem?.classList.toggle("is-after-bedtime", todoLate);
    todoItem?.classList.toggle("is-before-bedtime", !todoLate);
    allItem?.classList.toggle("is-after-bedtime", allLate);
    allItem?.classList.toggle("is-before-bedtime", !allLate);

    if (todoLate && allLate) {
      metric.classList.add("is-overdue");
      metric.title = "Les deux fins prévues dépassent l’heure de coucher";
    } else if (allLate) {
      metric.classList.add("is-warning");
      metric.title = "Fin avec Plus tard dépasse l’heure de coucher";
    } else {
      metric.classList.add("is-safe");
      metric.title = "Les deux fins prévues précèdent l’heure de coucher";
    }
  }

  parseSleepDuration(value) {
    const match = String(value || "")
      .trim()
      .match(/^(\d{1,2})(?::([0-5]\d))?$/);
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2] || 0);
    const total = hours * 60 + minutes;
    return total > 0 && total <= 24 * 60 ? total : null;
  }

  setSummaryValue(summary, key, value) {
    const element = summary.querySelector(`[data-summary-value="${key}"]`);
    if (element && element.textContent !== value) {
      element.textContent = value;
    }
  }

  calculateRemainingByLane(root, now = Date.now()) {
    const boardPath = this.getBoardPath(root);
    const cachedTasks = this.boardTasks.get(boardPath);
    if (cachedTasks) {
      return this.calculateRemainingFromTasks(cachedTasks, boardPath, now);
    }

    const tasks = [];
    for (const card of root.querySelectorAll(CARD_SELECTOR)) {
      const details = this.readCard(card);
      if (!details) continue;

      tasks.push({
        ...details,
        laneTitle: (
          card.closest(LANE_SELECTOR)?.querySelector(".kanban-plugin__lane-title-text")
            ?.textContent || ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLocaleLowerCase(),
      });
    }

    return this.calculateRemainingFromTasks(tasks, boardPath, now);
  }

  calculateRemainingFromTasks(tasks, boardPath, now = Date.now()) {
    const occurrences = new Map();
    let todoMs = 0;
    let laterMs = 0;

    for (const task of tasks) {
      const baseKey = `${boardPath}::${task.stableText}`;
      const occurrence = (occurrences.get(baseKey) || 0) + 1;
      occurrences.set(baseKey, occurrence);
      if (task.completed || DONE_LANES.has(task.laneTitle)) continue;

      const key = `${baseKey}::${occurrence}`;
      const sublistPath = task.sublistLink
        ? this.resolveLinkedPath(task.sublistLink, boardPath)
        : "";
      let remainingMs;

      if (sublistPath) {
        const aggregate = this.calculateBoardAggregate(sublistPath, now);
        remainingMs =
          aggregate === null
            ? task.durationMs
            : Math.max(0, aggregate.differenceMs);
      } else {
        const timer = this.getTimer(key, task.durationMs);
        remainingMs = Math.max(0, timer.durationMs - this.currentElapsed(timer, now));
      }

      if (task.laneTitle === TODO_LANE) {
        todoMs += remainingMs;
      } else if (task.laneTitle === LATER_LANE) {
        laterMs += remainingMs;
      }
    }

    return { todoMs, laterMs };
  }

  async ensureBoardTasks(boardPath) {
    if (
      !boardPath ||
      boardPath === "kanban" ||
      this.boardTasks.has(boardPath) ||
      this.boardTaskLoads.has(boardPath)
    ) {
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(boardPath);
    if (!file || file.extension !== "md") return;

    const load = this.app.vault
      .cachedRead(file)
      .then((content) => {
        this.boardTasks.set(boardPath, this.parseBoardTasks(content));
        this.queueRender();
      })
      .catch((error) => {
        console.error("Kanban Task Timer: unable to read board tasks", error);
      })
      .finally(() => {
        this.boardTaskLoads.delete(boardPath);
      });

    this.boardTaskLoads.set(boardPath, load);
    await load;
  }

  parseBoardTasks(content) {
    const tasks = [];
    let laneTitle = "";

    for (const line of content.split(/\r?\n/)) {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) {
        laneTitle = heading[1].replace(/\s+/g, " ").trim().toLocaleLowerCase();
        continue;
      }

      const card = line.match(/^\s*-\s+\[([^\]])\]\s+(.*)$/);
      if (!card) continue;

      const details = this.parseTaskText(card[2]);
      if (details) {
        tasks.push({
          ...details,
          completed: /x/i.test(card[1]),
          laneTitle,
          sublistLink: this.extractSublistLink(card[2]),
        });
      }
    }

    return tasks;
  }

  readCard(card) {
    const content =
      card.querySelector(
        ".kanban-plugin__item-title, .kanban-plugin__item-content-wrapper, .kanban-plugin__item-content"
      ) || card;
    const clone = content.cloneNode(true);
    clone
      .querySelectorAll(`.${CONTROL_CLASS}, .${DELETE_CLASS}, .${FORCED_START_LABEL_CLASS}`)
      .forEach((element) => element.remove());
    const details = this.parseTaskText(clone.textContent || "");
    if (!details) return null;

    const linkedElement = Array.from(
      content.querySelectorAll("a.internal-link[data-href]")
    ).find((element) => {
      const target = (element.dataset.href || "").trim();
      const label = (element.textContent || "").replace(/\s+/g, " ").trim();
      return (
        target.startsWith(`${SUBLIST_FOLDER}/`) ||
        label.toLocaleLowerCase() === SUBLIST_ALIAS.toLocaleLowerCase()
      );
    });

    return {
      ...details,
      sublistLink: linkedElement?.dataset.href?.trim() || "",
    };
  }

  readCardLoose(card) {
    const content =
      card.querySelector(
        ".kanban-plugin__item-title, .kanban-plugin__item-content-wrapper, .kanban-plugin__item-content"
      ) || card;
    const clone = content.cloneNode(true);
    clone.querySelectorAll(
      `.${CONTROL_CLASS}, .${DELETE_CLASS}, .${FORCED_START_LABEL_CLASS}`
    ).forEach((element) =>
      element.remove()
    );
    const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
    const details = this.parseLooseTaskText(text);
    if (!details) return null;
    const { taskTitle: title, stableText } = details;
    const linkedElement = Array.from(content.querySelectorAll("a.internal-link[data-href]")).find(
      (element) => {
        const target = (element.dataset.href || "").trim();
        const label = (element.textContent || "").replace(/\s+/g, " ").trim();
        return (
          target.startsWith(`${SUBLIST_FOLDER}/`) ||
          label.toLocaleLowerCase() === SUBLIST_ALIAS.toLocaleLowerCase()
        );
      }
    );

    return {
      durationMs: details.durationMs,
      stableText,
      taskTitle: title,
      sublistLink: linkedElement?.dataset.href?.trim() || "",
    };
  }

  parseLooseTaskText(sourceText) {
    const text = String(sourceText || "").replace(/\s+/g, " ").trim();
    const match = text.match(/(?:\u2014|\u2013|-)\s*(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?!\d)/);
    if (!match) return null;

    const durationMs =
      ((Number(match[1]) * 60 + Number(match[2])) * 60 +
        Number(match[3] === undefined ? 0 : match[3])) *
      SECOND;
    const taskTitle = text
      .slice(0, match.index)
      .replace(WIKI_LINK_PATTERN, (_link, target, alias) => alias || target)
      .trim();
    if (!taskTitle) return null;

    const stableText = taskTitle
      .replace(/^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D)+\s*/u, "")
      .toLocaleLowerCase();
    return { durationMs, taskTitle, stableText };
  }

  parseTaskText(sourceText) {
    const text = sourceText.replace(/\s+/g, " ").trim();
    const match = text.match(DURATION_PATTERN);
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = match[3] === undefined ? 0 : Number(match[3]);
    const durationMs = ((hours * 60 + minutes) * 60 + seconds) * SECOND;
    if (!Number.isFinite(durationMs) || durationMs < 0) return null;

    const withoutDuration = `${text.slice(0, match.index)}${text.slice(
      match.index + match[0].length
    )}`
      .replace(/\s+/g, " ")
      .trim();
    const withoutLinks = withoutDuration
      .replace(WIKI_LINK_PATTERN, (_link, target, alias) => {
        const label = (alias || "").replace(/\s+/g, " ").trim();
        if (label) return label;
        return String(target || "")
          .replace(/\\/g, "/")
          .split("/")
          .pop()
          .trim();
      })
      .replace(new RegExp(`\\b${SUBLIST_ALIAS}\\b`, "gi"), " ")
      .replace(/\s+/g, " ")
      .trim();
    const taskTitle = withoutLinks
      .replace(/^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D)+\s*/u, "")
      .trim();
    const stableText = withoutLinks
      .replace(/^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D)+\s*/u, "")
      .toLocaleLowerCase();

    return { durationMs, stableText, taskTitle };
  }

  extractSublistLink(sourceText) {
    WIKI_LINK_PATTERN.lastIndex = 0;
    let match;
    while ((match = WIKI_LINK_PATTERN.exec(sourceText)) !== null) {
      const target = (match[1] || "").trim();
      const alias = (match[2] || "").replace(/\s+/g, " ").trim();
      if (
        target.startsWith(`${SUBLIST_FOLDER}/`) ||
        alias.toLocaleLowerCase() === SUBLIST_ALIAS.toLocaleLowerCase()
      ) {
        return target;
      }
    }
    return "";
  }

  resolveLinkedPath(linkPath, sourcePath) {
    if (!linkPath) return "";
    const destination = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
    if (destination?.extension === "md") return destination.path;

    const normalized = linkPath.replace(/\\/g, "/").replace(/^\/+/, "");
    return normalized.toLocaleLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
  }

  calculateBoardAggregate(
    boardPath,
    now = Date.now(),
    visited = new Set(),
    includeCompleted = false
  ) {
    if (!boardPath || visited.has(boardPath)) return null;

    const tasks = this.boardTasks.get(boardPath);
    if (!tasks) {
      void this.ensureBoardTasks(boardPath);
      return null;
    }

    const nextVisited = new Set(visited);
    nextVisited.add(boardPath);
    const occurrences = new Map();
    let differenceMs = 0;
    let running = false;
    const refs = [];

    for (const task of tasks) {
      const baseKey = `${boardPath}::${task.stableText}`;
      const occurrence = (occurrences.get(baseKey) || 0) + 1;
      occurrences.set(baseKey, occurrence);

      if (!includeCompleted && (task.completed || DONE_LANES.has(task.laneTitle))) {
        continue;
      }

      const sublistPath = task.sublistLink
        ? this.resolveLinkedPath(task.sublistLink, boardPath)
        : "";
      if (sublistPath) {
        const nested = this.calculateBoardAggregate(
          sublistPath,
          now,
          nextVisited,
          includeCompleted
        );
        if (nested) {
          differenceMs += nested.differenceMs;
          running ||= nested.running;
          refs.push(...nested.refs);
        } else {
          differenceMs += task.durationMs;
        }
        continue;
      }

      const key = `${baseKey}::${occurrence}`;
      const timer = this.getTimer(key, task.durationMs);
      differenceMs += timer.durationMs - this.currentElapsed(timer, now);
      running ||= timer.running;
      refs.push({
        key,
        boardPath,
        stableText: task.stableText,
        occurrence,
        durationMs: task.durationMs,
        timer,
      });
    }

    return { differenceMs, running, refs };
  }

  getBoardPath(card) {
    const leaves = this.app.workspace.getLeavesOfType("kanban");
    for (const leaf of leaves) {
      if (leaf.view?.containerEl?.contains(card)) {
        return leaf.view.file?.path || leaf.view.getState?.().file || "kanban";
      }
    }
    return this.app.workspace.getActiveFile()?.path || "kanban";
  }

  getTimer(key, durationMs) {
    let timer = this.store.timers[key];
    if (!timer) {
      timer = {
        durationMs,
        elapsedMs: 0,
        startedAt: null,
        running: false,
      };
      this.store.timers[key] = timer;
      this.queueSave();
      return timer;
    }

    if (
      !timer.running &&
      timer.elapsedMs === 0 &&
      timer.durationMs !== durationMs &&
      !this.pendingCheckpointDurations.has(key)
    ) {
      timer.durationMs = durationMs;
      this.queueSave();
    }

    return timer;
  }

  renderCardTimer(card, details) {
    const {
      key,
      boardPath,
      stableText,
      occurrence,
      durationMs,
      taskTitle,
      sublistPath,
    } = details;
    let controls = card.querySelector(`:scope > .${CONTROL_CLASS}`);
    if (!controls) {
      controls = document.createElement("div");
      controls.className = CONTROL_CLASS;
      controls.innerHTML = `
        <button class="${CONTROL_CLASS}__toggle" type="button"></button>
        <span class="${CONTROL_CLASS}__display" aria-live="polite"></span>
        <button class="${CONTROL_CLASS}__forced-start" type="button" aria-label="Forced start time"></button>
        <button class="${CONTROL_CLASS}__sublist" type="button">↳</button>
        <button class="${CONTROL_CLASS}__unlink" type="button">×</button>
        <button class="${CONTROL_CLASS}__reset" type="button" aria-label="Réinitialiser le minuteur">↺</button>
      `;

      for (const eventName of ["pointerdown", "mousedown", "touchstart", "click"]) {
        controls.addEventListener(eventName, (event) => event.stopPropagation());
      }

      controls
        .querySelector(`.${CONTROL_CLASS}__toggle`)
        .addEventListener("click", (event) => {
          event.preventDefault();
          void this.toggleTimer(controls);
        });

      controls
        .querySelector(`.${CONTROL_CLASS}__sublist`)
        .addEventListener("click", (event) => {
          event.preventDefault();
          void this.createOrOpenSublist(controls);
        });

      controls
        .querySelector(`.${CONTROL_CLASS}__unlink`)
        .addEventListener("click", (event) => {
          event.preventDefault();
          void this.detachSublist(controls);
        });

      controls
        .querySelector(`.${CONTROL_CLASS}__forced-start`)
        .addEventListener("click", (event) => {
          event.preventDefault();
          void this.setForcedStart(controls);
        });

      controls
        .querySelector(`.${CONTROL_CLASS}__reset`)
        .addEventListener("click", (event) => {
          event.preventDefault();
          void this.requestResetControlsTimer(controls);
        });

      card.appendChild(controls);
    }

    controls.dataset.timerKey = key;
    controls.dataset.boardPath = boardPath;
    controls.dataset.stableText = stableText;
    controls.dataset.occurrence = String(occurrence);
    controls.dataset.durationMs = String(durationMs);
    controls.dataset.taskTitle = taskTitle || stableText;
    controls.dataset.sublistPath = sublistPath || "";
    controls.classList.toggle(
      "is-mobile-layout",
      Boolean(
        this.app?.isMobile ||
          document.body?.classList.contains("is-mobile") ||
          document.documentElement?.classList.contains("is-mobile")
      )
    );

    const forcedStart = this.store.forcedStarts[key] || "";
    const forcedStartButton = controls.querySelector(`.${CONTROL_CLASS}__forced-start`);
    forcedStartButton.replaceChildren();
    setIcon(forcedStartButton, "clock");
    const sublistIconButton = controls.querySelector(`.${CONTROL_CLASS}__sublist`);
    sublistIconButton.replaceChildren();
    setIcon(sublistIconButton, "corner-down-right");
    const unlinkIconButton = controls.querySelector(`.${CONTROL_CLASS}__unlink`);
    unlinkIconButton.replaceChildren();
    setIcon(unlinkIconButton, "x");
    const resetIconButton = controls.querySelector(`.${CONTROL_CLASS}__reset`);
    resetIconButton.replaceChildren();
    setIcon(resetIconButton, "rotate-ccw");
    forcedStartButton.classList.toggle("has-forced-start", Boolean(forcedStart));
    forcedStartButton.title = forcedStart
      ? `DÃ©but imposÃ© : ${forcedStart} (cliquer pour modifier)`
      : "DÃ©finir une heure de dÃ©but imposÃ©e";
    forcedStartButton.title = forcedStart
      ? `Heure impos\u00e9e : ${forcedStart}`
      : "D\u00e9finir une heure de d\u00e9but impos\u00e9e";
    forcedStartButton.setAttribute("aria-label", forcedStartButton.title);
    forcedStartButton.removeAttribute("title");

    const deleteButton = this.ensureDeleteButton(card);
    deleteButton.dataset.boardPath = boardPath;
    deleteButton.dataset.stableText = stableText;
    deleteButton.dataset.occurrence = String(occurrence);
    deleteButton.dataset.taskTitle = taskTitle || stableText;
    card.classList.add(`${DELETE_CLASS}-container`);

    const sublistButton = controls.querySelector(`.${CONTROL_CLASS}__sublist`);
    const sublistLabel = sublistPath
      ? "Ouvrir la sous-liste liée"
      : "Créer une sous-liste liée";
    sublistButton.classList.toggle("has-sublist", Boolean(sublistPath));
    sublistButton.setAttribute("aria-label", sublistLabel);
    sublistButton.setAttribute("title", sublistLabel);

    const unlinkButton = controls.querySelector(`.${CONTROL_CLASS}__unlink`);
    unlinkButton.hidden = !sublistPath;
    unlinkButton.setAttribute(
      "aria-label",
      "Détacher la sous-liste de cette tâche sans supprimer sa note"
    );
    unlinkButton.setAttribute(
      "title",
      "Détacher la sous-liste (son contenu sera conservé)"
    );

    if (!sublistPath) this.getTimer(key, durationMs);
    this.updateControls(controls);
  }

  renderCompactForcedStart(card, key) {
    let button = card.querySelector(`.${FORCED_START_COMPACT_CLASS}`);
    if (!button) {
      button = document.createElement("button");
      button.className = `${FORCED_START_COMPACT_CLASS} clickable-icon`;
      button.type = "button";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setCompactForcedStart(button);
      });
      const host =
        card.querySelector(".kanban-plugin__item-postfix-button-wrapper") || card;
      const deleteButton = host.querySelector(`.${DELETE_CLASS}`);
      host.insertBefore(button, deleteButton || null);
    }
    button.dataset.timerKey = key;
    button.replaceChildren();
    setIcon(button, "clock");
    const forcedStart = this.store.forcedStarts[key] || "";
    button.classList.toggle("has-forced-start", Boolean(forcedStart));
    button.title = forcedStart
      ? `Heure impos\u00e9e : ${forcedStart}`
      : "D\u00e9finir une heure de d\u00e9but impos\u00e9e";
    button.setAttribute("aria-label", button.title);
    button.removeAttribute("title");
  }

  setCompactForcedStart(button) {
    const key = button?.dataset.timerKey;
    if (!key) return;
    const oldInput = button.parentElement?.querySelector(
      `.${CONTROL_CLASS}__forced-start-input`
    );
    if (oldInput) {
      oldInput.remove();
      return;
    }
    const input = document.createElement("input");
    input.className = `${CONTROL_CLASS}__forced-start-input`;
    input.type = "text";
    input.inputMode = "numeric";
    input.placeholder = "HH:MM";
    input.value = this.store.forcedStarts[key] || "";
    input.title = "Heure de d\u00e9but impos\u00e9e";
    input.setAttribute("aria-label", "Heure de d\u00e9but impos\u00e9e");
    button.parentElement?.insertBefore(input, button);
    input.addEventListener("change", () => {
      const normalized = input.value.trim();
      if (normalized && !/^([01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
        input.focus();
        return;
      }
      if (normalized) this.store.forcedStarts[key] = normalized;
      else delete this.store.forcedStarts[key];
      input.remove();
      this.queueSave(true);
      this.queueRender();
    });
    input.addEventListener("blur", () => window.setTimeout(() => input.remove(), 150));
    input.focus();
  }

  ensureMobileResetButton(card, controls) {
    let button = card.querySelector(`.${MOBILE_RESET_CLASS}`);
    if (!button) {
      button = document.createElement("button");
      button.className = `${MOBILE_RESET_CLASS} clickable-icon`;
      button.type = "button";
      button.setAttribute("aria-label", "Réinitialiser le minuteur");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.requestResetControlsTimer(controls);
      });
      const host =
        card.querySelector(".kanban-plugin__item-postfix-button-wrapper") || card;
      host.insertBefore(button, host.querySelector(`.${DELETE_CLASS}`) || null);
    }
    button.replaceChildren();
    setIcon(button, "rotate-ccw");
  }

  setForcedStart(controls) {
    const key = controls?.dataset.timerKey;
    if (!key) return;

    const current = this.store.forcedStarts[key] || "";
    const oldInput = controls.querySelector(`.${CONTROL_CLASS}__forced-start-input`);
    if (oldInput) {
      oldInput.remove();
      return;
    }

    const input = document.createElement("input");
    input.className = `${CONTROL_CLASS}__forced-start-input`;
    input.type = "text";
    input.inputMode = "numeric";
    input.placeholder = "HH:MM";
    input.value = current;
    input.title = "Heure de début imposée";
    input.setAttribute("aria-label", "Heure de début imposée");
    const button = controls.querySelector(`.${CONTROL_CLASS}__forced-start`);
    controls.insertBefore(input, button);
    input.addEventListener("change", () => {
      const normalized = input.value.trim();
      if (normalized && !/^([01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
        input.focus();
        return;
      }
      if (normalized) this.store.forcedStarts[key] = normalized;
      else delete this.store.forcedStarts[key];
      input.remove();
      this.queueSave(true);
      this.queueRender();
    });
    input.addEventListener("blur", () => {
      window.setTimeout(() => input.remove(), 150);
    });
    input.title = "Heure de d\u00e9but impos\u00e9e";
    input.setAttribute("aria-label", "Heure de d\u00e9but impos\u00e9e");
    input.focus();
  }

  ensureDeleteButton(card) {
    let deleteButton = card.querySelector(`.${DELETE_CLASS}`);
    if (deleteButton) return deleteButton;

    deleteButton = document.createElement("button");
    deleteButton.className = `${DELETE_CLASS} clickable-icon`;
    deleteButton.type = "button";
    deleteButton.textContent = "×";
    deleteButton.replaceChildren();
    setIcon(deleteButton, "x");
    deleteButton.setAttribute("aria-label", "Supprimer la carte");
    deleteButton.setAttribute("title", "Supprimer la carte");
    const deleteCardFromButton = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (deleteButton.dataset.deleting === "true") return;
      deleteButton.dataset.deleting = "true";
      void this.deleteCard(deleteButton, card)
        .catch((error) => {
          console.error("Kanban Task Timer: unable to delete the card", error);
        })
        .finally(() => {
          delete deleteButton.dataset.deleting;
        });
    };
    for (const eventName of ["pointerdown", "mousedown", "touchstart", "click"]) {
      deleteButton.addEventListener(eventName, deleteCardFromButton, true);
    }
    const buttonHost =
      card.querySelector(".kanban-plugin__item-postfix-button-wrapper") || card;
    buttonHost.appendChild(deleteButton);
    card.classList.add(`${DELETE_CLASS}-container`);
    return deleteButton;
  }

  currentElapsed(timer, now = Date.now()) {
    const activeElapsed =
      timer.running && Number.isFinite(timer.startedAt)
        ? Math.max(0, now - timer.startedAt)
        : 0;
    return Math.max(0, Number(timer.elapsedMs) || 0) + activeElapsed;
  }

  async deleteCard(button, card) {
    let boardPath = button?.dataset.boardPath;
    let stableText = button?.dataset.stableText;
    let occurrence = Number(button?.dataset.occurrence) || 0;
    let title = button?.dataset.taskTitle || "";

    if ((!boardPath || !stableText || !occurrence) && card) {
      const details = this.readCard(card) || this.readCardLoose(card);
      if (!details) return;

      boardPath = this.getBoardPath(card);
      stableText = details.stableText;
      title = details.taskTitle;
      occurrence = 0;
      for (const candidate of document.querySelectorAll(CARD_SELECTOR)) {
        const candidateDetails = this.readCard(candidate) || this.readCardLoose(candidate);
        if (
          candidateDetails?.stableText === stableText &&
          this.getBoardPath(candidate) === boardPath
        ) {
          occurrence += 1;
        }
        if (candidate === card) break;
      }
    }

    title ||= "cette carte";
    if (!boardPath || !stableText || !occurrence) return;
    const file = this.app.vault.getAbstractFileByPath(boardPath);
    if (!file || file.extension !== "md") return;
    let matchCount = 0;
    let changed = false;
    await this.processFile(file, (content) => {
      const lines = content.split(/(\r?\n)/);
      const next = [];
      for (let index = 0; index < lines.length; index += 2) {
        const line = lines[index];
        const newline = lines[index + 1] || "";
        const match = line.match(/^\s*-\s+\[[^\]]\]\s+(.*)$/);
        if (match) {
          const parsed = this.parseTaskText(match[1]) || this.parseLooseTaskText(match[1]);
          if (parsed?.stableText === stableText) {
            matchCount += 1;
            if (matchCount === occurrence) {
              changed = true;
              continue;
            }
          }
        }
        next.push(line, newline);
      }
      return changed ? next.join("") : content;
    });

    if (!changed) return;
    delete this.store.timers[`${boardPath}::${stableText}::${occurrence}`];
    this.boardTasks.delete(boardPath);
    this.queueSave(true);
    this.queueRender();
  }

  async createOrOpenSublist(controls) {
    let sublistPath = controls?.dataset.sublistPath || "";
    if (sublistPath) {
      await this.openSublist(sublistPath);
      return;
    }

    const boardPath = controls?.dataset.boardPath;
    const stableText = controls?.dataset.stableText;
    const occurrence = Number(controls?.dataset.occurrence) || 1;
    const durationMs = Number(controls?.dataset.durationMs);
    if (!boardPath || !stableText || !Number.isFinite(durationMs)) return;

    try {
      if (!this.app.vault.getAbstractFileByPath(SUBLIST_FOLDER)) {
        await this.app.vault.createFolder(SUBLIST_FOLDER);
      }

      const baseName = this.sanitizeFileName(controls.dataset.taskTitle || stableText);
      sublistPath = normalizePath(`${SUBLIST_FOLDER}/${baseName}.md`);
      let existingSublist = await this.getExistingSublist(sublistPath);
      let suffix = 2;
      while (!existingSublist && this.app.vault.getAbstractFileByPath(sublistPath)) {
        sublistPath = normalizePath(`${SUBLIST_FOLDER}/${baseName} (${suffix}).md`);
        existingSublist = await this.getExistingSublist(sublistPath);
        suffix += 1;
      }

      if (!existingSublist) {
        const initialDuration = this.formatCardDuration(durationMs);
        const content = `---

kanban-plugin: board
kanban-task-timer-sublist: true

---

## À faire

- [ ] ⏱️ À détailler — ${initialDuration}


## Terminé



%% kanban:settings
\`\`\`
{"kanban-plugin":"board","new-card-insertion-method":"append","list-collapse":[false,false]}
\`\`\`
%%
`;
        await this.app.vault.create(sublistPath, content);
      }

      const linked = await this.addSublistLinkToCard({
        boardPath,
        stableText,
        occurrence,
        sublistPath,
      });
      if (!linked) return;

      this.boardTasks.delete(boardPath);
      this.boardTasks.delete(sublistPath);
      controls.dataset.sublistPath = sublistPath;
      await this.ensureBoardTasks(sublistPath);
      this.queueRender();
      await this.openSublist(sublistPath);
    } catch (error) {
      console.error("Kanban Task Timer: unable to create the linked sublist", error);
    }
  }

  async getExistingSublist(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== "md") return null;

    const content = await this.app.vault.cachedRead(file);
    return SUBLIST_MARKER_PATTERN.test(content) ? file : null;
  }

  sanitizeFileName(value) {
    const cleaned = String(value || "")
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();
    return cleaned || "Sous-liste";
  }

  async addSublistLinkToCard({ boardPath, stableText, occurrence, sublistPath }) {
    const file = this.app.vault.getAbstractFileByPath(boardPath);
    if (!file || file.extension !== "md") return false;

    const target = sublistPath.replace(/\.md$/i, "");
    let matchingOccurrence = 0;
    let changed = false;

    await this.processFile(file, (content) =>
      content.replace(/^(\s*-\s+\[[^\]]\]\s+)(.*)$/gm, (line, prefix, body) => {
        const parsed = this.parseTaskText(body);
        if (!parsed || parsed.stableText !== stableText) return line;

        matchingOccurrence += 1;
        if (matchingOccurrence !== occurrence) return line;
        if (this.extractSublistLink(body)) return line;

        const durationMatch = body.match(DURATION_PATTERN);
        if (!durationMatch) return line;

        const title = body
          .slice(0, durationMatch.index)
          .trim()
          .replace(/\|/g, "–")
          .replace(/\]/g, "");
        const durationPart = body.slice(durationMatch.index).trimStart();
        if (!title) return line;

        changed = true;
        return `${prefix}[[${target}|${title}]] ${durationPart}`;
      })
    );

    return changed;
  }

  async detachSublist(controls) {
    const boardPath = controls?.dataset.boardPath;
    const stableText = controls?.dataset.stableText;
    const occurrence = Number(controls?.dataset.occurrence) || 1;
    const sublistPath = controls?.dataset.sublistPath;
    const file = this.app.vault.getAbstractFileByPath(boardPath);
    if (!boardPath || !stableText || !sublistPath || !file || file.extension !== "md") {
      return;
    }

    await this.ensureBoardTasks(sublistPath);
    let aggregate = this.calculateBoardAggregate(sublistPath);
    if (aggregate?.running) {
      for (const ref of aggregate.refs.filter((item) => item.timer.running)) {
        await this.pauseTimerRef(ref);
      }
      await this.ensureBoardTasks(sublistPath);
      aggregate = this.calculateBoardAggregate(sublistPath);
    }

    const remainingMs =
      aggregate && aggregate.differenceMs > 0
        ? aggregate.differenceMs
        : Number(controls.dataset.durationMs);
    const nextDuration = this.formatCardDuration(remainingMs);
    let matchingOccurrence = 0;
    let changed = false;

    await this.processFile(file, (content) =>
      content.replace(/^(\s*-\s+\[[^\]]\]\s+)(.*)$/gm, (line, prefix, body) => {
        const parsed = this.parseTaskText(body);
        if (!parsed || parsed.stableText !== stableText) return line;

        matchingOccurrence += 1;
        if (matchingOccurrence !== occurrence) return line;

        const detachedBody = body
          .replace(WIKI_LINK_PATTERN, (link, target, alias) => {
            if (this.resolveLinkedPath(target.trim(), boardPath) !== sublistPath) {
              return link;
            }

            const label = (alias || "").replace(/\s+/g, " ").trim();
            if (label && label.toLocaleLowerCase() !== SUBLIST_ALIAS.toLocaleLowerCase()) {
              return label;
            }
            return label ? "" : String(target).replace(/\\/g, "/").split("/").pop();
          })
          .replace(/\s+/g, " ")
          .trim();
        const durationMatch = detachedBody.match(DURATION_PATTERN);
        if (!durationMatch) return line;

        const durationPrefix = durationMatch[0].slice(
          0,
          durationMatch[0].indexOf(durationMatch[1])
        );
        const nextBody = `${detachedBody.slice(
          0,
          durationMatch.index
        )}${durationPrefix}${nextDuration}${detachedBody.slice(
          durationMatch.index + durationMatch[0].length
        )}`.trim();

        changed = true;
        return `${prefix}${nextBody}`;
      })
    );

    if (!changed) return;

    const key = controls.dataset.timerKey;
    this.store.timers[key] = {
      durationMs: remainingMs,
      elapsedMs: 0,
      startedAt: null,
      running: false,
    };
    controls.dataset.sublistPath = "";
    controls.dataset.durationMs = String(remainingMs);
    this.boardTasks.delete(boardPath);
    this.queueSave(true);
    this.queueRender();
  }

  async openSublist(sublistPath) {
    const file = this.app.vault.getAbstractFileByPath(sublistPath);
    if (!file || file.extension !== "md") return;
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async processFile(file, processor) {
    if (!file?.path) return;

    const path = file.path;
    const previous = this.fileProcessQueues.get(path) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        let lastError;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            const currentFile = this.app.vault.getAbstractFileByPath(path) || file;
            return await this.app.vault.process(currentFile, processor);
          } catch (error) {
            lastError = error;
            if (attempt < 4) {
              await new Promise((resolve) => window.setTimeout(resolve, 150));
            }
          }
        }
        throw lastError;
      });
    this.fileProcessQueues.set(path, next);

    try {
      return await next;
    } finally {
      if (this.fileProcessQueues.get(path) === next) {
        this.fileProcessQueues.delete(path);
      }
    }
  }

  async waitForFileSettled(paths) {
    const relevantPaths = [...new Set(paths.filter(Boolean))];
    if (relevantPaths.length === 0) return;

    while (true) {
      const latestModification = Math.max(
        0,
        ...relevantPaths.map((path) => this.fileModifiedAt.get(path) || 0)
      );
      const remaining = FILE_SETTLE_DELAY - (Date.now() - latestModification);
      if (remaining <= 0) return;
      await new Promise((resolve) => window.setTimeout(resolve, remaining));
    }
  }

  async waitForKanbanSave() {
    // Kanban saves card moves asynchronously. Let its own save finish before
    // changing the linked sublist, otherwise Obsidian can report a false
    // external-modification conflict.
    await new Promise((resolve) => window.setTimeout(resolve, 2500));
  }

  async toggleTimer(controls) {
    const sublistPath = controls?.dataset.sublistPath;
    if (sublistPath) {
      await this.toggleSublistTimer(sublistPath);
      return;
    }

    const key = controls?.dataset.timerKey;
    if (!key) return;
    const timer = this.store.timers[key];
    if (!timer) return;

    if (timer.running) {
      await this.pauseTimerRef({
        key,
        boardPath: controls.dataset.boardPath,
        stableText: controls.dataset.stableText,
        occurrence: Number(controls.dataset.occurrence) || 1,
        durationMs: Number(controls.dataset.durationMs),
        timer,
        controls,
      });
    } else {
      if ((controls.dataset.boardPath || "").startsWith(`${SUBLIST_FOLDER}/`)) {
        await this.pauseOtherTimersInBoard(controls.dataset.boardPath, key);
      }
      timer.resetDurationMs = timer.durationMs;
      timer.startedAt = Date.now();
      timer.running = true;
    }

    this.queueSave(true);
    this.updateVisibleTimers();
  }

  async toggleSublistTimer(sublistPath) {
    await this.ensureBoardTasks(sublistPath);
    const aggregate = this.calculateBoardAggregate(sublistPath);
    if (!aggregate || aggregate.refs.length === 0) return;

    if (aggregate.running) {
      for (const ref of aggregate.refs.filter((item) => item.timer.running)) {
        await this.pauseTimerRef(ref);
      }
      await this.syncParentCardDurations(sublistPath);
    } else {
      for (const ref of aggregate.refs) {
        ref.timer.resetDurationMs = ref.timer.durationMs;
      }
      const next =
        aggregate.refs.find(
          (ref) => ref.timer.durationMs - this.currentElapsed(ref.timer) > 0
        ) || aggregate.refs[0];
      next.timer.startedAt = Date.now();
      next.timer.running = true;
    }

    this.queueSave(true);
    this.updateVisibleTimers();
  }

  async pauseOtherTimersInBoard(boardPath, exceptKey) {
    await this.ensureBoardTasks(boardPath);
    const aggregate = this.calculateBoardAggregate(boardPath);
    if (!aggregate) return;

    for (const ref of aggregate.refs) {
      if (ref.key !== exceptKey && ref.timer.running) {
        await this.pauseTimerRef(ref);
      }
    }
  }

  async pauseTimerRef(ref) {
    const timer = ref.timer || this.store.timers[ref.key];
    if (!timer?.running) return;

    timer.elapsedMs = this.currentElapsed(timer);
    timer.startedAt = null;
    timer.running = false;

    const remainingMs = timer.durationMs - timer.elapsedMs;
    if (remainingMs > 0) {
      const checkpointMs = Math.ceil(remainingMs / SECOND) * SECOND;
      timer.durationMs = checkpointMs;
      timer.elapsedMs = 0;
      if (ref.controls) {
        ref.controls.dataset.durationMs = String(checkpointMs);
      }
      this.queueCheckpointWrite(ref, checkpointMs);
    }

    this.queueSave(true);
    if ((ref.boardPath || "").startsWith(`${SUBLIST_FOLDER}/`)) {
      await this.syncParentCardDurations(ref.boardPath);
    }
  }

  cancelCheckpointWrite(key) {
    if (!key) return;
    this.pendingCheckpointDurations.delete(key);
    this.pendingCheckpointWrites.set(
      key,
      (this.pendingCheckpointWrites.get(key) || 0) + 1
    );
  }

  queueCheckpointWrite(ref, remainingMs) {
    const key = ref?.key;
    if (!key || !ref?.boardPath || !ref?.stableText) return;

    const revision = (this.pendingCheckpointWrites.get(key) || 0) + 1;
    this.pendingCheckpointWrites.set(key, revision);
    this.pendingCheckpointDurations.set(key, remainingMs);

    void (async () => {
      // A pause is immediately reflected in the timer UI. Delay only the
      // Markdown change so a drag-and-drop save from Kanban cannot race it.
      if ((ref.boardPath || "").startsWith(`${SUBLIST_FOLDER}/`)) {
        await this.waitForKanbanSave();
      }
      await this.waitForFileSettled([ref.boardPath]);

      if (this.pendingCheckpointWrites.get(key) !== revision) return;
      await this.writeRemainingTimeToTask(ref, remainingMs);
      if (this.pendingCheckpointWrites.get(key) === revision) {
        this.pendingCheckpointWrites.delete(key);
        this.pendingCheckpointDurations.delete(key);
      }
    })().catch((error) => {
      console.error("Kanban Task Timer: unable to save paused timer", error);
    });
  }

  async writeRemainingTimeToTask(ref, remainingMs) {
    const boardPath = ref.boardPath;
    const stableText = ref.stableText;
    const targetOccurrence = Number(ref.occurrence) || 1;
    const file = this.app.vault.getAbstractFileByPath(boardPath);
    if (!file || file.extension !== "md") return false;

    const nextDuration = this.formatCardDuration(remainingMs);
    let changed = false;
    let occurrence = 0;

    try {
      await this.processFile(file, (content) =>
        content.replace(/^(\s*-\s+\[[^\]]\]\s+)(.*)$/gm, (line, prefix, body) => {
          const parsed = this.parseTaskText(body);
          if (!parsed || parsed.stableText !== stableText) return line;

          occurrence += 1;
          if (occurrence !== targetOccurrence) return line;

          const durationMatch = body.match(DURATION_PATTERN);
          if (!durationMatch) return line;

          const durationPrefix = durationMatch[0].slice(
            0,
            durationMatch[0].indexOf(durationMatch[1])
          );
          const nextBody = `${body.slice(0, durationMatch.index)}${durationPrefix}${nextDuration}${body.slice(
            durationMatch.index + durationMatch[0].length
          )}`;
          changed = true;
          return `${prefix}${nextBody}`;
        })
      );
    } catch (error) {
      console.error("Kanban Task Timer: unable to save remaining time", error);
      return false;
    }

    return changed;
  }

  async requestResetControlsTimer(controls) {
    if (!controls || this.resetRequests.has(controls)) return;
    this.resetRequests.add(controls);

    try {
      // Let Kanban finish replacing the dropped card, then use the new
      // controls rather than a detached copy from the drag animation.
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      const timerKey = controls.dataset.timerKey;
      const liveControls = timerKey
        ? Array.from(document.querySelectorAll(`.${CONTROL_CLASS}`)).find(
            (candidate) => candidate.isConnected && candidate.dataset.timerKey === timerKey
          )
        : null;
      await this.resetControlsTimer(liveControls || controls);
    } finally {
      this.resetRequests.delete(controls);
    }
  }

  async resetControlsTimer(controls) {
    const card = controls?.closest(CARD_SELECTOR);
    const liveDetails = card && (this.readCard(card) || this.readCardLoose(card));
    const boardPath = card ? this.getBoardPath(card) : controls?.dataset.boardPath;
    const stableText = liveDetails?.stableText || controls?.dataset.stableText;
    const sublistPath = liveDetails?.sublistLink
      ? this.resolveLinkedPath(liveDetails.sublistLink, boardPath)
      : controls?.dataset.sublistPath;
    if (sublistPath) {
      await this.waitForKanbanSave();
      await this.waitForFileSettled([sublistPath, boardPath]);
      await this.ensureBoardTasks(sublistPath);
      const aggregate = this.calculateBoardAggregate(
        sublistPath,
        Date.now(),
        new Set(),
        true
      );
      if (!aggregate) return;

      await this.restoreTimerRefs(aggregate.refs);
      this.queueSave(true);
      await this.syncParentCardDurations(sublistPath);
      this.updateVisibleTimers();
      return;
    }

    let occurrence = Number(controls?.dataset.occurrence) || 1;
    if (card && stableText) {
      occurrence = 0;
      for (const candidate of document.querySelectorAll(CARD_SELECTOR)) {
        const candidateDetails =
          this.readCard(candidate) || this.readCardLoose(candidate);
        if (
          candidateDetails?.stableText === stableText &&
          this.getBoardPath(candidate) === boardPath
        ) {
          occurrence += 1;
        }
        if (candidate === card) break;
      }
      occurrence ||= 1;
    }

    const liveKey =
      boardPath && stableText
        ? `${boardPath}::${stableText}::${occurrence}`
        : "";
    const previousKey = controls?.dataset.timerKey || "";
    const key =
      [liveKey, previousKey].find((candidate) => {
        const candidateTimer = this.store.timers[candidate];
        return Number.isFinite(Number(candidateTimer?.resetDurationMs));
      }) || liveKey || previousKey;
    const ref = {
      key,
      boardPath,
      stableText,
      occurrence,
      durationMs: liveDetails?.durationMs ?? Number(controls?.dataset.durationMs),
      controls,
    };
    const timer = this.store.timers[key];
    if (!timer) return;

    this.cancelCheckpointWrite(key);
    const restoredDurationMs = this.restoreTimerState(ref, timer);
    if (!Number.isFinite(restoredDurationMs)) return;

    this.queueSave(true);
    this.updateVisibleTimers();

    if ((boardPath || "").startsWith(`${SUBLIST_FOLDER}/`)) {
      await this.waitForKanbanSave();
    }
    await this.waitForFileSettled([boardPath]);

    const persisted = await this.writeRemainingTimeToTask(
      ref,
      restoredDurationMs
    );
    if (!persisted) {
      timer.resetDurationMs = restoredDurationMs;
    }

    if ((boardPath || "").startsWith(`${SUBLIST_FOLDER}/`)) {
      await this.syncParentCardDurations(boardPath);
    }
    this.updateVisibleTimers();
  }

  async restoreTimerRef(ref) {
    const timer = ref?.timer || this.store.timers[ref?.key];
    if (!timer) return;

    this.cancelCheckpointWrite(ref.key);
    const restoredDurationMs = this.restoreTimerState(ref, timer);
    if (!Number.isFinite(restoredDurationMs)) return;

    let persisted = true;
    if (ref.boardPath && ref.stableText) {
      persisted = await this.writeRemainingTimeToTask(ref, restoredDurationMs);
    }
    if (!persisted) {
      timer.resetDurationMs = restoredDurationMs;
    }
  }

  restoreTimerState(ref, timer = ref?.timer || this.store.timers[ref?.key]) {
    if (!timer) return null;

    const savedDurationMs = Number(timer.resetDurationMs);
    const noteDurationMs = Number(ref.durationMs);
    const restoredDurationMs =
      Number.isFinite(savedDurationMs) && savedDurationMs > 0
        ? savedDurationMs
        : Number.isFinite(noteDurationMs) && noteDurationMs > 0
          ? noteDurationMs
          : timer.durationMs;

    timer.durationMs = restoredDurationMs;
    timer.elapsedMs = 0;
    timer.startedAt = null;
    timer.running = false;
    timer.resetDurationMs = restoredDurationMs;

    if (ref.controls) {
      ref.controls.dataset.durationMs = String(restoredDurationMs);
    }
    return restoredDurationMs;
  }

  async restoreTimerRefs(refs) {
    const restorationsByBoard = new Map();

    for (const ref of refs) {
      this.cancelCheckpointWrite(ref.key);
      const restoredDurationMs = this.restoreTimerState(ref);
      if (!Number.isFinite(restoredDurationMs) || !ref.boardPath || !ref.stableText) {
        continue;
      }
      if (!restorationsByBoard.has(ref.boardPath)) {
        restorationsByBoard.set(ref.boardPath, []);
      }
      restorationsByBoard.get(ref.boardPath).push({
        stableText: ref.stableText,
        occurrence: Number(ref.occurrence) || 1,
        durationMs: restoredDurationMs,
      });
    }

    for (const [boardPath, restorations] of restorationsByBoard) {
      const changed = await this.writeTaskDurations(boardPath, restorations);
      if (changed) {
        this.boardTasks.delete(boardPath);
        await this.ensureBoardTasks(boardPath);
      }
    }
  }

  async writeTaskDurations(boardPath, restorations) {
    const file = this.app.vault.getAbstractFileByPath(boardPath);
    if (!file || file.extension !== "md") return false;

    const restorationMap = new Map(
      restorations.map((item) => [
        `${item.stableText}::${item.occurrence}`,
        item.durationMs,
      ])
    );
    const occurrences = new Map();
    let changed = false;

    await this.processFile(file, (content) =>
      content.replace(/^(\s*-\s+\[[^\]]\]\s+)(.*)$/gm, (line, prefix, body) => {
        const parsed = this.parseTaskText(body);
        if (!parsed) return line;

        const occurrence = (occurrences.get(parsed.stableText) || 0) + 1;
        occurrences.set(parsed.stableText, occurrence);
        const restoredDurationMs = restorationMap.get(
          `${parsed.stableText}::${occurrence}`
        );
        if (!Number.isFinite(restoredDurationMs)) return line;

        const durationMatch = body.match(DURATION_PATTERN);
        if (!durationMatch) return line;
        const durationPrefix = durationMatch[0].slice(
          0,
          durationMatch[0].indexOf(durationMatch[1])
        );
        const nextDuration = this.formatCardDuration(restoredDurationMs);
        const nextBody = `${body.slice(0, durationMatch.index)}${durationPrefix}${nextDuration}${body.slice(
          durationMatch.index + durationMatch[0].length
        )}`;
        if (nextBody === body) return line;
        changed = true;
        return `${prefix}${nextBody}`;
      })
    );

    return changed;
  }

  queueCardDurationSync(boardPath) {
    const existing = this.cardDurationSyncQueued.get(boardPath);
    if (existing) window.clearTimeout(existing);

    const timeoutId = window.setTimeout(() => {
      this.cardDurationSyncQueued.delete(boardPath);
      void this.ensureMissingCardDurations(boardPath);
    }, 200);
    this.cardDurationSyncQueued.set(boardPath, timeoutId);
  }

  async ensureMissingCardDurations(boardPath, requireSublistMarker = false) {
    const file = this.app.vault.getAbstractFileByPath(boardPath);
    if (!file || file.extension !== "md") return false;

    let changed = false;
    await this.processFile(file, (content) => {
      if (!/^kanban-plugin:\s*board\s*$/m.test(content)) return content;
      if (requireSublistMarker && !SUBLIST_MARKER_PATTERN.test(content)) return content;

      return content.replace(
        /^(\s*-\s+\[([^\]])\]\s+)(.*)$/gm,
        (line, prefix, checkmark, body) => {
          const title = body.trim();
          if (
            /x/i.test(checkmark) ||
            !title ||
            title.startsWith("```") ||
            DURATION_PATTERN.test(title)
          ) {
            return line;
          }

          changed = true;
          return `${prefix}${title} — 1:00`;
        }
      );
    });

    if (changed) {
      this.boardTasks.delete(boardPath);
      this.queueRender();
      if (boardPath.startsWith(`${SUBLIST_FOLDER}/`)) {
        this.queueParentDurationSync(boardPath);
      }
    }
    return changed;
  }

  queueSublistDurationSync(sublistPath) {
    const existing = this.sublistDurationSyncQueued.get(sublistPath);
    if (existing) window.clearTimeout(existing);

    const timeoutId = window.setTimeout(() => {
      this.sublistDurationSyncQueued.delete(sublistPath);
      void this.ensureSubtaskDurations(sublistPath);
    }, 200);
    this.sublistDurationSyncQueued.set(sublistPath, timeoutId);
  }

  async ensureExistingSubtaskDurations() {
    const sublistFiles = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${SUBLIST_FOLDER}/`));

    for (const file of sublistFiles) {
      await this.ensureSubtaskDurations(file.path);
    }
  }

  async ensureSubtaskDurations(sublistPath) {
    const file = this.app.vault.getAbstractFileByPath(sublistPath);
    if (!file || file.extension !== "md") return false;

    await this.ensureBoardTasks(sublistPath);
    const aggregate = this.calculateBoardAggregate(sublistPath);
    const unallocatedRef = aggregate?.refs.find((ref) =>
      this.isUnallocatedTask(ref.stableText)
    );
    if (unallocatedRef?.timer?.running) {
      await this.pauseTimerRef(unallocatedRef);
    }

    let changed = false;
    await this.processFile(file, (content) => {
      if (!SUBLIST_MARKER_PATTERN.test(content)) return content;

      const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      let laneTitle = "";
      let unallocated = null;
      let target = null;

      for (let index = 0; index < lines.length; index += 1) {
        const heading = lines[index].match(/^##\s+(.+?)\s*$/);
        if (heading) {
          laneTitle = heading[1].replace(/\s+/g, " ").trim().toLocaleLowerCase();
          continue;
        }

        const card = lines[index].match(/^(\s*-\s+\[([^\]])\]\s+)(.*)$/);
        if (!card || /x/i.test(card[2]) || DONE_LANES.has(laneTitle)) continue;

        const body = card[3].trim();
        if (!body) continue;

        const parsed = this.parseTaskText(body);
        if (parsed && this.isUnallocatedTask(parsed.stableText) && !unallocated) {
          const durationMatch = body.match(DURATION_PATTERN);
          if (durationMatch) {
            unallocated = {
              index,
              durationToken: durationMatch[0],
            };
          }
          continue;
        }

        if (!parsed && !this.isUnallocatedTask(body) && !target) {
          target = {
            index,
            prefix: card[1],
            title: body,
          };
        }
      }

      if (!unallocated || !target) return content;

      lines[target.index] =
        `${target.prefix}${target.title} ${unallocated.durationToken}`;
      lines.splice(unallocated.index, 1);
      changed = true;
      return lines.join(lineEnding);
    });

    if (changed) {
      if (unallocatedRef?.key) {
        delete this.store.timers[unallocatedRef.key];
        this.queueSave(true);
      }
      this.boardTasks.delete(sublistPath);
      await this.ensureBoardTasks(sublistPath);
      await this.syncParentCardDurations(sublistPath);
      this.queueRender();
    }
    if (changed) return true;
    return this.ensureMissingCardDurations(sublistPath, true);
  }

  isUnallocatedTask(value) {
    const normalized = String(value || "")
      .replace(
        /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D)+\s*/u,
        ""
      )
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
    return normalized === "a detailler";
  }

  queueParentDurationSync(sublistPath) {
    const existing = this.parentSyncQueued.get(sublistPath);
    if (existing) window.clearTimeout(existing);

    const timeoutId = window.setTimeout(() => {
      this.parentSyncQueued.delete(sublistPath);
      void (async () => {
        await this.ensureBoardTasks(sublistPath);
        await this.syncParentCardDurations(sublistPath);
      })();
    }, 350);
    this.parentSyncQueued.set(sublistPath, timeoutId);
  }

  async syncParentCardDurations(sublistPath) {
    const aggregate = this.calculateBoardAggregate(sublistPath);
    if (!aggregate) return;

    const nextDuration = this.formatCardDuration(Math.max(0, aggregate.differenceMs));
    const parentFiles = this.app.vault.getMarkdownFiles().filter((file) => {
      if (file.path === sublistPath) return false;
      const cache = this.app.metadataCache.getFileCache(file);
      return (cache?.links || []).some(
        (link) => this.resolveLinkedPath(link.link, file.path) === sublistPath
      );
    });

    for (const file of parentFiles) {
      let changed = false;
      await this.processFile(file, (content) =>
        content.replace(/^(\s*-\s+\[[^\]]\]\s+)(.*)$/gm, (line, prefix, body) => {
          const linkedPath = this.extractSublistLink(body);
          if (!linkedPath || this.resolveLinkedPath(linkedPath, file.path) !== sublistPath) {
            return line;
          }

          const durationMatch = body.match(DURATION_PATTERN);
          if (!durationMatch) return line;

          const durationPrefix = durationMatch[0].slice(
            0,
            durationMatch[0].indexOf(durationMatch[1])
          );
          const nextBody = `${body.slice(
            0,
            durationMatch.index
          )}${durationPrefix}${nextDuration}${body.slice(
            durationMatch.index + durationMatch[0].length
          )}`;
          if (nextBody === body) return line;

          changed = true;
          return `${prefix}${nextBody}`;
        })
      );

      if (changed) this.boardTasks.delete(file.path);
    }

    this.queueRender();
  }

  updateVisibleTimers() {
    document.querySelectorAll(`.${CONTROL_CLASS}`).forEach((controls) => {
      this.updateControls(controls);
    });
    this.renderLaneTotals();
    this.updateCardForcedWarnings();
    this.updateSummaries();
  }

  updateControls(controls) {
    const sublistPath = controls.dataset.sublistPath;
    let differenceMs;
    let running;

    if (sublistPath) {
      const aggregate = this.calculateBoardAggregate(sublistPath);
      if (aggregate) {
        differenceMs = aggregate.differenceMs;
        running = aggregate.running;
      }
    }

    if (!Number.isFinite(differenceMs)) {
      const key = controls.dataset.timerKey;
      const durationMs = Number(controls.dataset.durationMs);
      const timer = this.getTimer(key, durationMs);
      differenceMs = timer.durationMs - this.currentElapsed(timer);
      running = timer.running;
    }

    const overtime = differenceMs < 0;
    const shownMs = Math.abs(differenceMs);

    const display = controls.querySelector(`.${CONTROL_CLASS}__display`);
    const toggle = controls.querySelector(`.${CONTROL_CLASS}__toggle`);

    display.textContent = `${overtime ? "+" : ""}${this.formatDuration(shownMs)}`;
    controls.classList.toggle("is-running", running);
    controls.classList.toggle("is-overtime", overtime);
    controls.classList.toggle("has-sublist", Boolean(sublistPath));

    toggle.textContent = running ? "⏸" : "▶";
    toggle.replaceChildren();
    setIcon(toggle, running ? "pause" : "play");
    toggle.setAttribute(
      "aria-label",
      running
        ? sublistPath
          ? "Mettre la sous-liste en pause"
          : "Mettre le minuteur en pause"
        : sublistPath
          ? "Démarrer la prochaine sous-tâche"
          : "Démarrer ou reprendre le minuteur"
    );
  }

  formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / SECOND));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  }

  formatCardDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / SECOND));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const base = `${hours}:${String(minutes).padStart(2, "0")}`;
    return seconds === 0 ? base : `${base}:${String(seconds).padStart(2, "0")}`;
  }

  formatClockTime(timestamp, referenceTimestamp = Date.now()) {
    const date = new Date(timestamp);
    const reference = new Date(referenceTimestamp);
    const time = new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    const dayNumber = (value) =>
      Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / (24 * 60 * 60 * SECOND);
    const dayDifference = dayNumber(date) - dayNumber(reference);

    if (dayDifference === 0) return time;
    if (dayDifference === 1) return `demain ${time}`;

    const weekday = new Intl.DateTimeFormat("fr-FR", { weekday: "short" })
      .format(date)
      .replace(/\.$/, "");
    return `${weekday} ${time}`;
  }

  formatCompactDuration(milliseconds) {
    const totalMinutes = Math.max(0, Math.ceil(milliseconds / MINUTE));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes} min`;
    if (minutes === 0) return `${hours} h`;
    return `${hours} h ${minutes} min`;
  }

  queueSave(immediate = false) {
    if (this.saveQueued) {
      window.clearTimeout(this.saveQueued);
      this.saveQueued = null;
    }

    if (immediate) {
      void this.saveData(this.store);
      return;
    }

    this.saveQueued = window.setTimeout(() => {
      this.saveQueued = null;
      void this.saveData(this.store);
    }, 300);
  }
};
