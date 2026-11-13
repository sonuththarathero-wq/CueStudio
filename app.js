
const $ = id => document.getElementById(id);
const DEFAULT_PROJECT_PATH = "projects/Katina%202026.json";
const DEFAULT_PROJECT_NAME = "Katina 2026.json";

function createBlankProject() {
    return {
        title: "New Katina Ceremony",
        settings: {},
        scripts: [{
            id: crypto.randomUUID(),
            title: "Opening Sequence",
            type: "custom",
            cues: [{
                id: crypto.randomUUID(),
                text: "",
                performer: "",
                note: "",
                duration: 10,
                mode: "auto",
                marker: null,
                upcomingColor: null
            }]
        }]
    };
}

let project = createBlankProject();

let selectedScript = 0;
let selectedCue = 0;

let running = false;
let paused = false;
let elapsed = 0;
let completed = false;
let playbackAnchor = null;
let speed = 1;
let animationFrame = null;
let liveFontSize = 18;
let displayedCueId = null;
let activeProjectHandle = null;
let projectLoaded = false;
let bundledProjectLoaded = false;
let projectDirty = false;
let projectRevision = 0;
let projectWriteQueue = Promise.resolve();
let globalElapsedMs = 0;
let globalElapsedStartedAt = null;
let globalTimerInterval = null;
let confirmationAction = null;
let confirmationReturnFocus = null;
let markerSidebarOpen = false;
let activeMobileDrawer = null;
let projectInfoTouched = false;
let wasMobileLayout = window.matchMedia("(max-width: 700px)").matches;

const typeNames = {
    drum: "DRUM PERFORMANCE",
    chant: "Kavi",
    group: "GROUP Kavi",
    custom: "CUSTOM CUE"
};

function currentScript() {
    return project.scripts[selectedScript];
}

function currentCue() {
    return currentScript()?.cues[selectedCue];
}

function allCues() {
    return project.scripts.flatMap((script, scriptIndex) =>
        script.cues.map((cue, cueIndex) => ({
            ...cue,
            scriptIndex,
            cueIndex
        }))
    );
}

function findScriptWithCue(startIndex, direction) {
    for (let index = startIndex; index >= 0 && index < project.scripts.length; index += direction) {
        if (project.scripts[index].cues.length) return index;
    }

    return -1;
}

function getNextPlayableCue(scriptIndex, cueIndex) {
    for (let scriptIndexToCheck = scriptIndex;
        scriptIndexToCheck < project.scripts.length;
        scriptIndexToCheck++) {
        const script = project.scripts[scriptIndexToCheck];
        const firstCueIndex = scriptIndexToCheck === scriptIndex
            ? cueIndex + 1
            : 0;

        if (firstCueIndex < script.cues.length) {
            return {
                script,
                cue: script.cues[firstCueIndex],
                scriptIndex: scriptIndexToCheck,
                cueIndex: firstCueIndex
            };
        }
    }

    return null;
}

function validateProject(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("The project must be a JSON object.");
    }
    if (!Array.isArray(data.scripts) || !data.scripts.length) {
        throw new Error("The project must contain at least one script.");
    }

    const ids = new Set();
    let cueCount = 0;
    const makeId = () => crypto.randomUUID();
    const validatedScripts = data.scripts.map((script, scriptIndex) => {
        if (!script || typeof script !== "object" || Array.isArray(script)) {
            throw new Error(`Script ${scriptIndex + 1} is invalid.`);
        }
        if (!Array.isArray(script.cues)) {
            throw new Error(`Script ${scriptIndex + 1} must have a cues array.`);
        }

        const scriptId = typeof script.id === "string" && script.id.trim()
            ? script.id
            : makeId();
        if (ids.has(scriptId)) throw new Error("Duplicate script or cue ID found.");
        ids.add(scriptId);

        const cues = script.cues.map((cue, cueIndex) => {
            if (!cue || typeof cue !== "object" || Array.isArray(cue)) {
                throw new Error(`Cue ${cueIndex + 1} in script ${scriptIndex + 1} is invalid.`);
            }

            const cueId = typeof cue.id === "string" && cue.id.trim()
                ? cue.id
                : makeId();
            if (ids.has(cueId)) throw new Error("Duplicate script or cue ID found.");
            ids.add(cueId);
            if (
                cue.duration !== undefined &&
                (!Number.isFinite(Number(cue.duration)) || Number(cue.duration) <= 0)
            ) {
                throw new Error(`Cue ${cueIndex + 1} in script ${scriptIndex + 1} has an invalid duration.`);
            }
            if (
                cue.mode !== undefined &&
                !["auto", "manual"].includes(cue.mode)
            ) {
                throw new Error(`Cue ${cueIndex + 1} in script ${scriptIndex + 1} has an invalid progression mode.`);
            }
            if (
                cue.marker !== undefined &&
                cue.marker !== null &&
                (!Number.isInteger(Number(cue.marker)) || Number(cue.marker) < 1)
            ) {
                throw new Error(`Cue ${cueIndex + 1} in script ${scriptIndex + 1} has an invalid recovery marker.`);
            }

            const cueColor = typeof cue.upcomingColor === "string"
                ? cue.upcomingColor.trim()
                : null;
            const normalizedColor = cueColor && Object.values(UP_NEXT_COLORS)
                .some(color => color.toLowerCase() === cueColor.toLowerCase())
                ? cueColor.toUpperCase()
                : null;

            cueCount++;
            const cueData = { ...cue };
            delete cueData.upcomingPerformer;
            return {
                ...cueData,
                id: cueId,
                text: typeof cue.text === "string" ? cue.text : "",
                performer: typeof cue.performer === "string" ? cue.performer : "",
                note: typeof cue.note === "string" ? cue.note : "",
                duration: Math.max(1, Number(cue.duration) || 10),
                mode: cue.mode === "manual" ? "manual" : "auto",
                marker: cue.marker == null ? null : Number(cue.marker),
                upcomingColor: normalizedColor
            };
        });

        return {
            ...script,
            id: scriptId,
            title: typeof script.title === "string" ? script.title : `Script ${scriptIndex + 1}`,
            type: Object.hasOwn(typeNames, script.type) ? script.type : "custom",
            cues
        };
    });

    if (!cueCount) throw new Error("The project must contain at least one cue.");

    return {
        ...data,
        title: typeof data.title === "string" && data.title.trim()
            ? data.title
            : "Katina Ceremony",
        settings: data.settings && typeof data.settings === "object" && !Array.isArray(data.settings)
            ? data.settings
            : {},
        scripts: validatedScripts
    };
}

function formatTime(seconds) {
    seconds = Math.max(0, Math.ceil(seconds));

    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;

    return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

const UP_NEXT_COLORS = {
    red: "#E53935",
    green: "#43A047",
    yellow: "#FDD835",
    white: "#FFFFFF"
};

function formatGlobalClock(valueMs) {
    const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderGlobalElapsed() {
    const display = $("globalElapsedTime");
    if (display) {
        display.textContent = formatGlobalClock(getGlobalElapsedTime());
    }
}

function getGlobalElapsedTime(now = performance.now()) {
    if (globalElapsedStartedAt === null) return globalElapsedMs;
    return globalElapsedMs + (now - globalElapsedStartedAt);
}

function startGlobalTimer(now = performance.now()) {
    globalElapsedStartedAt = now;
    if (globalTimerInterval !== null) clearInterval(globalTimerInterval);
    globalTimerInterval = setInterval(renderGlobalElapsed, 250);
    renderGlobalElapsed();
}

function pauseGlobalTimer(now = performance.now()) {
    if (globalElapsedStartedAt !== null) {
        globalElapsedMs += now - globalElapsedStartedAt;
        globalElapsedStartedAt = null;
    }
    if (globalTimerInterval !== null) {
        clearInterval(globalTimerInterval);
        globalTimerInterval = null;
    }
    renderGlobalElapsed();
}

function resetGlobalTimer(now = performance.now()) {
    globalElapsedMs = 0;
    if (running) {
        globalElapsedStartedAt = now;
    } else {
        globalElapsedStartedAt = null;
    }
    renderGlobalElapsed();
}

const supportsProjectFileAccess =
    typeof window.showOpenFilePicker === "function" &&
    typeof window.showSaveFilePicker === "function";

async function getWritePermission(handle, requestPermission) {
    const options = { mode: "readwrite" };
    if (await handle.queryPermission(options) === "granted") return true;
    if (!requestPermission) return false;
    return await handle.requestPermission(options) === "granted";
}

async function writeProjectFile(handle, requestPermission, data = project) {
    const serialized = JSON.stringify(data, null, 2);
    const write = projectWriteQueue.catch(() => {}).then(async () => {
        if (!await getWritePermission(handle, requestPermission)) {
            throw new Error("Write permission was denied. Use Save to grant access or Save As to choose another file.");
        }

        const writable = await handle.createWritable();
        try {
            await writable.write(serialized);
            await writable.close();
        } catch (error) {
            await writable.abort();
            throw error;
        }
    });
    projectWriteQueue = write;
    return write;
}

function exportProjectJson(fileName = bundledProjectLoaded ? DEFAULT_PROJECT_NAME : "project.json") {
    const blob = new Blob(
        [JSON.stringify(project, null, 2)],
        { type: "application/json;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveConnectedProject() {
    if (!activeProjectHandle) {
        if (bundledProjectLoaded) {
            await saveProjectAs();
            return;
        }
        $("saveStatus").textContent = projectLoaded
            ? "No project file connected · use Save As"
            : "No project loaded";
        return;
    }

    $("saveStatus").textContent = "Saving...";
    const handle = activeProjectHandle;
    const projectToSave = project;
    const revision = projectRevision;
    try {
        await writeProjectFile(handle, true, projectToSave);
        if (project !== projectToSave || activeProjectHandle !== handle) return;
        if (projectRevision === revision) {
            projectDirty = false;
            $("saveStatus").textContent = "Saved";
        } else {
            $("saveStatus").textContent = "Unsaved changes";
        }
    } catch (error) {
        if (project !== projectToSave || activeProjectHandle !== handle) return;
        $("saveStatus").textContent = "Save failed";
        console.error("Could not save project file.", error);
        alert(`Could not save project.json: ${error.message}`);
    }
}

async function saveProjectAs() {
    const projectToSave = project;
    if (!supportsProjectFileAccess) {
        exportProjectJson();
        projectLoaded = true;
        projectDirty = false;
        $("saveStatus").textContent = "Exported JSON · not connected";
        return;
    }

    try {
        const handle = await window.showSaveFilePicker({
            suggestedName: bundledProjectLoaded ? DEFAULT_PROJECT_NAME : "project.json",
            types: [{
                description: "Katina Cue Studio project",
                accept: { "application/json": [".json"] }
            }]
        });
        if (project !== projectToSave) return;
        const existing = await handle.getFile();
        if (
            existing.size > 0 &&
            !confirm(`"${handle.name}" already contains data. Replace it with this project?`)
        ) {
            return;
        }
        if (!await getWritePermission(handle, true)) {
            throw new Error("Write permission was denied.");
        }
        const revision = projectRevision;
        await writeProjectFile(handle, false, projectToSave);
        if (project !== projectToSave) return;
        activeProjectHandle = handle;
        bundledProjectLoaded = false;
        projectLoaded = true;
        if (projectRevision === revision) {
            projectDirty = false;
            $("saveStatus").textContent = "Saved";
        } else {
            $("saveStatus").textContent = "Unsaved changes";
        }
    } catch (error) {
        if (error.name === "AbortError") return;
        if (project !== projectToSave) return;
        $("saveStatus").textContent = "Save failed";
        console.error("Save As failed.", error);
        alert(`Could not save project file: ${error.message}`);
    }
}

function loadProjectData(data, fileName, handle = null, isBundledDefault = false) {
    const validated = validateProject(data);
    if (
        projectDirty &&
        !confirm(`Discard unsaved changes and open "${fileName}"?`)
    ) return false;

    stopPlayback();
    project = validated;
    activeProjectHandle = handle;
    bundledProjectLoaded = isBundledDefault;
    projectLoaded = true;
    projectDirty = false;
    selectedScript = findScriptWithCue(0, 1);
    if (selectedScript < 0) selectedScript = 0;
    selectedCue = 0;
    elapsed = 0;
    completed = false;
    globalElapsedMs = 0;
    globalElapsedStartedAt = null;
    renderAll();

    if (handle) {
        $("saveStatus").textContent = `Loaded: ${fileName}`;
    } else {
        $("saveStatus").textContent = `Loaded: ${fileName} · use Save As to connect`;
    }
    return true;
}

async function loadProjectFile(file, handle = null) {
    return loadProjectData(JSON.parse(await file.text()), file.name, handle);
}

async function openProjectWithPicker() {
    if (typeof window.showOpenFilePicker !== "function") {
        $("projectFile").click();
        return;
    }

    try {
        const [handle] = await window.showOpenFilePicker({
            multiple: false,
            types: [{
                description: "Katina Cue Studio project",
                accept: { "application/json": [".json"] }
            }]
        });
        const file = await handle.getFile();
        if (!await loadProjectFile(file, handle)) return;
    } catch (error) {
        if (error.name === "AbortError") return;
        $("saveStatus").textContent = "Save failed · project not loaded";
        console.error("Could not open project file.", error);
        alert(`Could not open project JSON: ${error.message}`);
    }
}

function markUnsaved() {
    projectRevision++;
    projectDirty = true;
    $("saveStatus").textContent = projectLoaded
        ? "Unsaved changes"
        : "No project loaded · unsaved changes";
}

function renderScripts() {
    const list = $("scriptList");
    list.innerHTML = "";

    project.scripts.forEach((script, index) => {
        const item = document.createElement("div");

        item.className = "script-item" +
            (index === selectedScript ? " active" : "");

        item.innerHTML = `
            <div class="script-index">SCRIPT ${String(index + 1).padStart(2, "0")}</div>
            <strong></strong>
            <small>${script.cues.length} cues · ${typeNames[script.type]}</small>
            <div class="script-order">
                <button type="button" class="move-script-up" aria-label="Move script up">↑</button>
                <button type="button" class="move-script-down" aria-label="Move script down">↓</button>
            </div>
        `;

        item.querySelector("strong").textContent = script.title;

        item.addEventListener("click", () => {
            selectedScript = index;
            selectedCue = 0;
            stopPlayback();
            elapsed = 0;
            closeMobileDrawers();
            renderAll();
        });

        item.querySelector(".move-script-up").disabled = index === 0;
        item.querySelector(".move-script-down").disabled =
            index === project.scripts.length - 1;
        item.querySelector(".move-script-up").onclick = event => {
            event.stopPropagation();
            moveScript(index, -1);
        };
        item.querySelector(".move-script-down").onclick = event => {
            event.stopPropagation();
            moveScript(index, 1);
        };

        list.appendChild(item);
    });

    $("scriptCount").textContent = `${project.scripts.length} scripts`;
    $("cueCount").textContent = `${allCues().length} cues`;
}

function renderEditor() {
    const script = currentScript();
    if (!script) return;

    $("projectTitle").value = project.title;
    $("scriptTitle").value = script.title;
    $("scriptType").value = script.type;

    const container = $("cueEditorList");
    container.innerHTML = "";

    script.cues.forEach((cue, index) => {
        const card = document.createElement("div");
        card.className = "cue-card";

        const optionButtons = Object.entries(UP_NEXT_COLORS)
            .map(([name, color]) => `
                <button
                    type="button"
                    class="up-next-swatch ${cue.upcomingColor === color ? "selected" : ""}"
                    data-color="${color}"
                    style="background:${color};"
                    title="${name[0].toUpperCase() + name.slice(1)}"
                    aria-label="${name[0].toUpperCase() + name.slice(1)} up next color"
                ></button>
            `)
            .join("");

        card.innerHTML = `
            <div class="cue-card-title">
                <strong>CUE ${String(index + 1).padStart(2, "0")}</strong>
                <div class="cue-order">
                    <button type="button" class="move-cue-up" aria-label="Move cue up">↑</button>
                    <button type="button" class="move-cue-down" aria-label="Move cue down">↓</button>
                    <button type="button" class="delete-cue" aria-label="Delete cue">×</button>
                </div>
            </div>

            <textarea class="cue-text" placeholder="Enter Sinhala or Pali text"></textarea>

            <div class="cue-grid">
                <label>
                    Performer / Group
                    <input class="cue-performer">
                </label>

                <label>
                    Duration (seconds)
                    <input class="cue-duration" type="number" min="1">
                </label>

                <label>
                    Progression
                    <select class="cue-mode">
                        <option value="auto">Automatic</option>
                        <option value="manual">Manual</option>
                    </select>
                </label>

                <label>
                    Note
                    <input class="cue-note">
                </label>
            </div>

            <div class="cue-options">
                <label>
                    <input class="cue-marker" type="checkbox">
                    Recovery marker
                </label>
            </div>

            <div class="up-next-color-panel">
                <span>Up Next Color</span>
                <div class="up-next-color-row">
                    ${optionButtons}
                    <button type="button" class="clear-up-next-color" title="Clear color">Clear</button>
                </div>
            </div>
        `;

        card.querySelector(".cue-text").value = cue.text;
        card.querySelector(".cue-performer").value = cue.performer;
        card.querySelector(".cue-duration").value = cue.duration;
        card.querySelector(".cue-mode").value = cue.mode;
        card.querySelector(".cue-note").value = cue.note;
        card.querySelector(".cue-marker").checked = !!cue.marker;

        const updateCue = () => {
            if (running && currentCue()?.id === cue.id) {
                advancePlaybackTo(performance.now());
            }

            cue.text = card.querySelector(".cue-text").value;
            cue.performer = card.querySelector(".cue-performer").value;
            cue.duration = Math.max(
                1,
                Number(card.querySelector(".cue-duration").value) || 1
            );
            cue.mode = card.querySelector(".cue-mode").value;
            cue.note = card.querySelector(".cue-note").value;

            if (card.querySelector(".cue-marker").checked) {
                cue.marker = Number(cue.marker) || findFreeMarker();
            } else {
                cue.marker = null;
            }

            renderLive();
            renderMarkers();
            if (running) {
                playbackAnchor = performance.now();
                schedulePlayback();
            }
            markUnsaved();
        };

        card.querySelectorAll("input:not(.cue-marker), textarea").forEach(element => {
            element.addEventListener("input", updateCue);
        });
        card.querySelectorAll("select, .cue-marker").forEach(element => {
            element.addEventListener("change", updateCue);
        });

        card.querySelectorAll(".up-next-swatch").forEach(button => {
            button.addEventListener("click", () => {
                cue.upcomingColor = button.dataset.color;
                renderEditor();
                renderLive();
                renderMarkers();
                markUnsaved();
            });
        });

        const clearColorButton = card.querySelector(".clear-up-next-color");
        clearColorButton.addEventListener("click", () => {
            cue.upcomingColor = null;
            renderEditor();
            renderLive();
            renderMarkers();
            markUnsaved();
        });

        card.querySelector(".delete-cue").onclick = () => {
            if (script.cues.length === 1) {
                alert("A script must contain at least one cue.");
                return;
            }

            script.cues.splice(index, 1);
            selectedCue = Math.min(selectedCue, script.cues.length - 1);

            renderAll();
            markUnsaved();
        };

        card.querySelector(".move-cue-up").disabled = index === 0;
        card.querySelector(".move-cue-down").disabled =
            index === script.cues.length - 1;
        card.querySelector(".move-cue-up").onclick = () =>
            moveCueWithinScript(index, -1);
        card.querySelector(".move-cue-down").onclick = () =>
            moveCueWithinScript(index, 1);

        container.appendChild(card);
    });
}

function renderLive() {
    const script = currentScript();
    const cue = currentCue();

    if (!script || !cue) return;

    if (displayedCueId !== cue.id) {
        displayedCueId = cue.id;
        $("liveText").scrollTop = 0;
    }

    $("liveScriptTitle").textContent = script.title;
    $("mobileCurrentScript").textContent = script.title;
    $("liveType").textContent = typeNames[script.type] || "CUSTOM CUE";

    $("livePerformer").textContent = cue.performer || "";
    $("liveText").textContent = cue.text || "Add cue text in the editor";
    $("liveText").style.fontSize = `${liveFontSize}px`;
    $("liveFontValue").textContent = `${liveFontSize}px`;
    $("liveNote").textContent = cue.note || "";
    const nextCue = getNextPlayableCue(selectedScript, selectedCue);
    const upcomingPanel = $("upcomingPanel");
    const upcoming = $("upcomingPerformer");
    const upcomingDuration = $("upcomingDuration");
    const upcomingHint = $("upcomingHint");
    const upcomingLabel = $("upcomingLabel");
    const nextColor = nextCue?.cue?.upcomingColor || null;
    if (nextColor) {
        upcomingPanel.style.background = nextColor;
        upcomingPanel.style.borderColor = nextColor;
        upcomingPanel.style.boxShadow = `inset 0 0 0 1px rgba(255,255,255,0.18)`;
        const isDarkText = ["#FDD835", "#FFFFFF"].includes(nextColor.toUpperCase());
        upcoming.style.color = isDarkText ? "#0f172a" : "#f8fbff";
        upcomingLabel.style.color = isDarkText ? "#0f172a" : "#f8fbff";
        upcomingHint.style.color = isDarkText ? "rgba(15, 23, 42, 0.8)" : "rgba(248, 251, 255, 0.8)";
        upcomingDuration.style.color = isDarkText ? "rgba(15, 23, 42, 0.8)" : "rgba(248, 251, 255, 0.8)";
        upcomingPanel.classList.add("has-color");
    } else {
        upcomingPanel.style.background = "linear-gradient(110deg, rgba(20, 60, 77, 0.96), rgba(15, 41, 58, 0.96))";
        upcomingPanel.style.borderColor = "rgba(53, 197, 213, 0.5)";
        upcomingPanel.style.boxShadow = "none";
        upcoming.style.color = "";
        upcomingLabel.style.color = "";
        upcomingHint.style.color = "";
        upcomingDuration.style.color = "";
        upcomingPanel.classList.remove("has-color");
    }
    upcoming.textContent = nextCue
        ? nextCue.cue.performer || "PERFORMER NOT SPECIFIED"
        : "END OF PROGRAM";
    upcoming.classList.toggle("end-of-program", !nextCue);
    upcomingPanel.classList.toggle("end-of-program", !nextCue);
    upcomingDuration.textContent = nextCue
        ? formatTime(nextCue.cue.duration)
        : "—";
    upcomingHint.textContent = nextCue ? "Prepare to focus" : "Final cue";

    $("cuePosition").textContent =
        `${String(selectedCue + 1).padStart(2, "0")} / ${String(script.cues.length).padStart(2, "0")}`;

    const remaining = Math.max(0, getCueDuration(cue) - elapsed);
    const countdown = $("countdown");
    countdown.textContent = formatTime(remaining);
    updateCountdownWarning(countdown, remaining);

    $("elapsedTime").textContent =
        `${Math.floor(elapsed)}s / ${cue.duration}s`;

    $("progressBar").style.width =
        `${Math.min(100, elapsed / cue.duration * 100)}%`;
    const progressTrack = $("progressBar").parentElement;
    progressTrack.setAttribute(
        "aria-valuenow",
        String(Math.round(Math.min(100, elapsed / cue.duration * 100)))
    );

    const liveStatus = $("liveStatus");
    const liveStatusText = liveStatus.querySelector(".status-text");
    const statusRunning = running;
    const statusLabel = statusRunning
        ? "LIVE"
        : completed ? "COMPLETED" : paused ? "PAUSED" : "READY";
    const playbackButtonLabel = statusRunning
        ? "Ⅱ Pause"
        : paused ? "▶ Resume" : completed ? "↺ Restart" : "▶ Start";
    liveStatus.classList.toggle("is-live", statusRunning);
    liveStatus.classList.toggle("complete", completed);
    liveStatusText.textContent = statusLabel;
    $("playPause").textContent = playbackButtonLabel;
    $("presenterPlayPause").textContent = playbackButtonLabel;

    renderGlobalElapsed();
    $("fullscreenSpeedValue").textContent = `${speed.toFixed(2)}×`;
    $("toggleFullscreenSpeed").textContent = `Speed · ${speed.toFixed(2)}×`;
    $("speedValue").textContent = `${speed.toFixed(2)}×`;
    $("mobileSpeedToggle").textContent =
        `Playback speed · ${speed.toFixed(2)}×`;
    const speedControlsOpen = document.body.classList.contains("mobile-speed-open");
    $("mobileSpeedToggle").setAttribute("aria-expanded", String(speedControlsOpen));
    $("toggleFullscreenSpeed").setAttribute("aria-expanded", String(speedControlsOpen));
}

function getCueDuration(cue) {
    return Math.max(1, Number(cue?.duration) || 1);
}

function updateCountdownWarning(countdown, remaining) {
    const warningActive = remaining <= 5;
    const warningProgress = warningActive
        ? Math.min(1, Math.max(0, (5 - remaining) / 5))
        : 0;
    const intensity = warningActive
        ? 0.08 + warningProgress * 0.92
        : 0;
    const colorProgress = warningActive
        ? 0.12 + Math.sqrt(warningProgress) * 0.88
        : 0;
    const normal = [232, 240, 246];
    const warning = [255, 43, 55];
    const color = normal.map((channel, index) =>
        Math.round(channel + (warning[index] - channel) * colorProgress)
    );
    const glow = colorProgress * colorProgress;
    const liveScreen = countdown.closest(".live-screen");

    liveScreen.style.setProperty(
        "--countdown-warning-intensity",
        intensity.toFixed(3)
    );
    liveScreen.classList.toggle("countdown-warning", warningActive);
    countdown.style.setProperty(
        "--countdown-pulse-scale",
        (1.008 + warningProgress * 0.047).toFixed(3)
    );
    countdown.style.color = `rgb(${color.join(", ")})`;
    countdown.style.textShadow = warningActive
        ? `0 0 ${4 + 18 * glow}px rgba(255, 35, 45, ${0.12 + 0.58 * glow}), 0 0 ${10 + 28 * glow}px rgba(255, 20, 35, ${0.05 + 0.38 * glow})`
        : "none";
    countdown.classList.toggle("is-warning", warningActive);
    countdown.classList.toggle("is-running", running);
    countdown.classList.toggle("is-completed", completed);
    countdown.classList.toggle("is-zero", remaining <= 0);
}

function setLiveFontSize(size) {
    liveFontSize = Math.max(10, Math.min(25, size));
    $("liveFontSize").value = liveFontSize;
    $("liveFontValue").textContent = `${liveFontSize}px`;
    $("liveText").style.fontSize = `${liveFontSize}px`;
}

function renderMarkers() {
    const containers = [$("markerList"), $("fullscreenMarkerList")].filter(Boolean);
    const markers = (currentScript()?.cues ?? [])
        .filter(cue => cue.marker)
        .sort((a, b) => Number(a.marker) - Number(b.marker));

    containers.forEach(container => {
        container.innerHTML = "";
        markers.forEach(cue => {
            const button = document.createElement("button");
            const cueIndex = currentScript().cues.indexOf(cue);
            const scriptIndex = selectedScript;

            button.className = "marker";
            button.innerHTML = `
                <span class="marker-key">${cue.marker}</span>
                <span></span>
            `;
            button.querySelector("span:last-child").textContent =
                cue.text || "Saved cue";
            button.onclick = () => {
                jumpToCue(scriptIndex, cueIndex);
                if (window.matchMedia("(max-width: 850px)").matches) {
                    setMarkerSidebarOpen(false);
                }
            };
            container.appendChild(button);
        });
    });
}

function setMarkerSidebarOpen(open) {
    const wasOpen = markerSidebarOpen;
    markerSidebarOpen = open;
    document.body.classList.toggle("markers-open", open);
    $("toggleMarkerSidebar").setAttribute("aria-expanded", String(open));
    $("mobileMarkersToggle").setAttribute("aria-expanded", String(open));
    $("fullscreenMarkerSidebar").setAttribute("aria-hidden", String(!open));
    $("markerPanel").setAttribute(
        "aria-hidden",
        String(window.matchMedia("(max-width: 700px)").matches && !open)
    );
    if (window.matchMedia("(max-width: 700px)").matches) {
        if (open) {
            activeMobileDrawer = "markers";
            $("mobileDrawerBackdrop").hidden = false;
        } else if (activeMobileDrawer === "markers") {
            activeMobileDrawer = null;
            $("mobileDrawerBackdrop").hidden = true;
        }
        syncMobileDrawerInertState();
        if (open) {
            const closeButton = $(document.body.classList.contains("app-fullscreen")
                ? "closeMarkerSidebar"
                : "closeMarkerPanel");
            requestAnimationFrame(() => {
                if (markerSidebarOpen) closeButton.focus();
            });
        } else if (wasOpen) {
            $(document.body.classList.contains("app-fullscreen")
                ? "toggleMarkerSidebar"
                : "mobileMarkersToggle").focus();
        }
    }
}

function closeMobileDrawers() {
    const previousDrawer = activeMobileDrawer;
    setMarkerSidebarOpen(false);
    ["scripts", "editor", "actions"].forEach(name => {
        document.body.classList.remove(`mobile-${name}-open`);
        const button = name === "scripts"
            ? $("mobileMenuToggle")
            : $(`mobile${name[0].toUpperCase()}${name.slice(1)}Toggle`);
        if (button) button.setAttribute("aria-expanded", "false");
    });
    activeMobileDrawer = null;
    $("mobileDrawerBackdrop").hidden = true;
    syncMobileDrawerInertState();
    const returnFocus = previousDrawer === "scripts"
        ? $("mobileMenuToggle")
        : previousDrawer === "editor"
            ? $("mobileEditorToggle")
            : previousDrawer === "actions"
                ? $("mobileActionsToggle")
                : previousDrawer === "markers"
                ? $(document.body.classList.contains("app-fullscreen")
                    ? "toggleMarkerSidebar"
                    : "mobileMarkersToggle")
                    : null;
    returnFocus?.focus();
}

function setMobileSpeedControlsOpen(open) {
    document.body.classList.toggle("mobile-speed-open", open);
    $("mobileSpeedToggle").setAttribute("aria-expanded", String(open));
    $("toggleFullscreenSpeed").setAttribute("aria-expanded", String(open));
}

function setMobileLiveFontControlOpen(open) {
    document.body.classList.toggle("mobile-live-font-open", open);
    $("mobileLiveFontToggle").setAttribute("aria-expanded", String(open));
}

function openMobileDrawer(name) {
    if (activeMobileDrawer === name) {
        closeMobileDrawers();
        return;
    }

    closeMobileDrawers();
    activeMobileDrawer = name;
    document.body.classList.add(`mobile-${name}-open`);
    const button = name === "scripts"
        ? $("mobileMenuToggle")
        : $(`mobile${name[0].toUpperCase()}${name.slice(1)}Toggle`);
    if (button) button.setAttribute("aria-expanded", "true");
    $("mobileDrawerBackdrop").hidden = false;
    syncMobileDrawerInertState();
    const closeButton = $(name === "scripts"
        ? "closeScriptsDrawer"
        : name === "editor"
            ? "closeEditorDrawer"
            : "closeProjectActions");
    requestAnimationFrame(() => {
        if (activeMobileDrawer === name) closeButton.focus();
    });
}

function syncMobileDrawerInertState() {
    const isMobile = window.matchMedia("(max-width: 700px)").matches;
    $("scriptsPanel").inert = isMobile && activeMobileDrawer !== "scripts";
    $("editorPanel").inert = isMobile && activeMobileDrawer !== "editor";
    document.querySelector(".mobile-navigation").inert =
        isMobile && activeMobileDrawer !== null;
    $("presentation").inert = isMobile &&
        activeMobileDrawer !== null && activeMobileDrawer !== "markers";
    $("presentationHeader").inert =
        isMobile && activeMobileDrawer === "markers";
    $("projectControls").inert = isMobile && activeMobileDrawer !== "actions";
    $("markerPanel").inert = isMobile && activeMobileDrawer !== "markers";
    $("fullscreenMarkerSidebar").inert =
        isMobile && activeMobileDrawer !== "markers";
    $("live-screen").inert = isMobile && activeMobileDrawer === "markers";
    $("control-panel").inert =
        isMobile && activeMobileDrawer === "markers";
    $("fullscreen-speed-panel").inert =
        isMobile && activeMobileDrawer === "markers";
    $("fullscreen-playback-controls").inert =
        isMobile && activeMobileDrawer === "markers";
}

function renderAll() {
    if (!currentCue()) {
        selectedScript = findScriptWithCue(
            Math.max(0, selectedScript),
            1
        );
        if (selectedScript < 0) selectedScript = findScriptWithCue(0, 1);
        selectedCue = 0;
    }

    renderScripts();
    renderEditor();
    renderLive();
    renderMarkers();
}

function findFreeMarker() {
    const used = (currentScript()?.cues ?? []).map(cue => Number(cue.marker));

    for (let i = 1; i <= 9; i++) {
        if (!used.includes(i)) return i;
    }

    return null;
}


// PLAYBACK ENGINE

function stopPlayback() {
    running = false;
    paused = false;
    completed = false;
    playbackAnchor = null;
    pauseGlobalTimer(performance.now());

    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
    }

    renderLive();
}

function pausePlayback() {
    advancePlaybackTo(performance.now());
    if (!running) return;

    running = false;
    paused = true;
    playbackAnchor = null;
    pauseGlobalTimer(performance.now());

    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
    }

    renderLive();
}

function resumePlayback() {
    if (!paused || running || completed) return;

    paused = false;
    running = true;
    playbackAnchor = performance.now();
    startGlobalTimer(playbackAnchor);
    renderLive();
    schedulePlayback();
}

function startPlayback() {
    if (running || !project.scripts.length) return;

    selectedScript = 0;
    selectedCue = 0;
    elapsed = 0;
    paused = false;
    completed = false;
    renderScripts();
    renderEditor();
    renderMarkers();
    globalElapsedMs = 0;
    startGlobalTimer(performance.now());

    running = true;
    playbackAnchor = performance.now();

    renderLive();
    schedulePlayback();
}

function togglePlayback() {
    if (running) {
        pausePlayback();
    } else if (paused) {
        resumePlayback();
    } else {
        startPlayback();
    }
}

function schedulePlayback() {
    if (!running || currentCue()?.mode !== "auto") {
        if (animationFrame !== null) {
            cancelAnimationFrame(animationFrame);
            animationFrame = null;
        }
        return;
    }

    if (animationFrame !== null) return;

    animationFrame = requestAnimationFrame(playbackTick);
}

function playbackTick(timestamp) {
    animationFrame = null;
    if (!running) return;

    advancePlaybackTo(timestamp);
    schedulePlayback();
}

function advancePlaybackTo(now) {
    if (!running || playbackAnchor === null) return;

    let remainingPlayback = Math.max(0, now - playbackAnchor) / 1000 * speed;
    playbackAnchor = now;
    let changedCue = false;
    const previousScript = selectedScript;

    while (running) {
        const cue = currentCue();
        if (!cue || cue.mode !== "auto") break;

        const duration = getCueDuration(cue);
        const cueTimeLeft = Math.max(0, duration - elapsed);
        if (remainingPlayback < cueTimeLeft) {
            elapsed += remainingPlayback;
            remainingPlayback = 0;
            break;
        }

        remainingPlayback -= cueTimeLeft;
        if (!advanceCueSelection()) {
            elapsed = duration;
            completeProgram();
            changedCue = true;
            break;
        }

        elapsed = 0;
        completed = false;
        changedCue = true;
    }

    if (changedCue && selectedScript !== previousScript) {
        renderScripts();
        renderEditor();
        renderMarkers();
    }

    renderLive();
}

function advanceCueSelection() {
    for (let scriptIndex = selectedScript;
        scriptIndex < project.scripts.length;
        scriptIndex++) {
        const firstCueIndex = scriptIndex === selectedScript
            ? selectedCue + 1
            : 0;
        if (firstCueIndex < project.scripts[scriptIndex].cues.length) {
            selectedScript = scriptIndex;
            selectedCue = firstCueIndex;
            return true;
        }
    }

    return false;
}

function moveScript(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= project.scripts.length) return;

    stopPlayback();
    [project.scripts[index], project.scripts[target]] =
        [project.scripts[target], project.scripts[index]];
    selectedScript = target;
    renderAll();
    markUnsaved();
}

function moveCueWithinScript(index, direction) {
    const cues = currentScript()?.cues;
    const target = index + direction;
    if (!cues || target < 0 || target >= cues.length) return;

    stopPlayback();
    [cues[index], cues[target]] = [cues[target], cues[index]];
    selectedCue = target;
    renderAll();
    markUnsaved();
}

function completeProgram() {
    running = false;
    paused = false;
    completed = true;
    playbackAnchor = null;
    pauseGlobalTimer(performance.now());

    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
    }
}

function moveCue(direction) {
    const wasRunning = running;
    if (wasRunning) advancePlaybackTo(performance.now());
    if (!project.scripts.length) return;

    if (!running && wasRunning) {
        completed = false;
    }

    const previousScript = selectedScript;
    if (direction > 0) {
        if (!advanceCueSelection()) {
            elapsed = getCueDuration(currentCue());
            completeProgram();
            renderAll();
            return;
        }
    } else if (selectedCue > 0) {
        selectedCue--;
    } else {
        let previousScript = selectedScript - 1;
        while (previousScript >= 0 && !project.scripts[previousScript].cues.length) {
            previousScript--;
        }
        if (previousScript < 0) {
            elapsed = 0;
            completed = false;
            if (wasRunning && running) playbackAnchor = performance.now();
            renderLive();
            schedulePlayback();
            return;
        }
        selectedScript = previousScript;
        selectedCue = currentScript().cues.length - 1;
    }

    completed = false;
    elapsed = 0;

    if (wasRunning && running) {
        playbackAnchor = performance.now();
    } else {
        playbackAnchor = null;
    }

    if (selectedScript !== previousScript) {
        renderScripts();
        renderEditor();
        renderMarkers();
    }
    renderLive();
    schedulePlayback();
}

function jumpToCue(scriptIndex, cueIndex) {
    const wasRunning = running;
    if (wasRunning) advancePlaybackTo(performance.now());
    const previousScript = selectedScript;

    selectedScript = scriptIndex;
    selectedCue = cueIndex;
    elapsed = 0;
    completed = false;

    if (wasRunning && running) {
        playbackAnchor = performance.now();
    } else {
        running = false;
        playbackAnchor = null;
    }

    if (selectedScript !== previousScript) {
        renderScripts();
        renderEditor();
        renderMarkers();
    }
    renderLive();
    schedulePlayback();
}

let presenterModeFallback = false;

function syncFullscreenState() {
    const isFullscreen = !!document.fullscreenElement || presenterModeFallback;
    const wasFullscreen = document.body.classList.contains("app-fullscreen");
    document.body.classList.toggle("app-fullscreen", isFullscreen);
    $("toggleFullscreen").textContent = isFullscreen ? "EXIT" : "Fullscreen";
    if (isFullscreen && !wasFullscreen &&
        !window.matchMedia("(max-width: 700px)").matches) {
        setMarkerSidebarOpen(true);
    } else if (!isFullscreen) {
        setMarkerSidebarOpen(false);
    } else {
        setMarkerSidebarOpen(false);
    }
}

async function toggleFullscreen() {
    if (!document.fullscreenElement && !presenterModeFallback) {
        if (typeof document.documentElement.requestFullscreen !== "function") {
            presenterModeFallback = true;
            syncFullscreenState();
            return;
        }
        try {
            await document.documentElement.requestFullscreen();
        } catch (error) {
            console.error("Could not enter fullscreen.", error);
            presenterModeFallback = true;
            syncFullscreenState();
        }
        return;
    }

    if (presenterModeFallback) {
        presenterModeFallback = false;
        syncFullscreenState();
    } else if (document.fullscreenElement) {
        await document.exitFullscreen();
    }
}


// BUTTONS

$("playPause").onclick = () => {
    togglePlayback();
};

$("nextCue").onclick = () => moveCue(1);
$("previousCue").onclick = () => moveCue(-1);
$("presenterPrevious").onclick = () => moveCue(-1);
$("presenterPlayPause").onclick = togglePlayback;
$("presenterNext").onclick = () => moveCue(1);
$("toggleMarkerSidebar").onclick = () =>
    setMarkerSidebarOpen(!markerSidebarOpen);
$("closeMarkerSidebar").onclick = () => setMarkerSidebarOpen(false);
$("mobileMenuToggle").onclick = () => openMobileDrawer("scripts");
$("mobileEditorToggle").onclick = () => openMobileDrawer("editor");
$("mobileActionsToggle").onclick = () => openMobileDrawer("actions");
$("mobileMarkersToggle").onclick = () =>
    setMarkerSidebarOpen(!markerSidebarOpen);
$("drawerOpenMarkers").onclick = () => {
    closeMobileDrawers();
    setMarkerSidebarOpen(true);
};
$("drawerOpenEditor").onclick = () => openMobileDrawer("editor");
$("drawerOpenActions").onclick = () => openMobileDrawer("actions");
$("drawerOpenSpeed").onclick = () => {
    closeMobileDrawers();
    setMobileSpeedControlsOpen(true);
};
$("drawerOpenTextSize").onclick = () => {
    closeMobileDrawers();
    setMobileLiveFontControlOpen(true);
};
$("closeScriptsDrawer").onclick = closeMobileDrawers;
$("closeEditorDrawer").onclick = closeMobileDrawers;
$("closeProjectActions").onclick = closeMobileDrawers;
$("closeMarkerPanel").onclick = () => setMarkerSidebarOpen(false);
$("mobileDrawerBackdrop").onclick = closeMobileDrawers;
$("mobileLiveFontToggle").onclick = () => {
    setMobileLiveFontControlOpen(
        !document.body.classList.contains("mobile-live-font-open")
    );
};
$("mobileSpeedToggle").onclick = () => {
    setMobileSpeedControlsOpen(
        !document.body.classList.contains("mobile-speed-open")
    );
};
$("toggleFullscreenSpeed").onclick = () => {
    setMobileSpeedControlsOpen(
        !document.body.classList.contains("mobile-speed-open")
    );
};
window.addEventListener("resize", () => {
    const isMobile = window.matchMedia("(max-width: 700px)").matches;
    if (isMobile !== wasMobileLayout) {
        if (!projectInfoTouched) {
            document.querySelector(".project-info").open = !isMobile;
        }
        wasMobileLayout = isMobile;
    }

    if (!isMobile) {
        closeMobileDrawers();
    } else {
        syncMobileDrawerInertState();
    }
});

$("restartCue").onclick = () => {
    const wasRunning = running;
    if (wasRunning) advancePlaybackTo(performance.now());
    if (!currentCue()) return;

    completed = false;
    elapsed = 0;
    if (wasRunning) {
        running = true;
        playbackAnchor = performance.now();
    }
    renderLive();
    schedulePlayback();
};

$("addScript").onclick = () => {
    project.scripts.push({
        id: crypto.randomUUID(),
        title: "New Script",
        type: "custom",
        cues: [{
            id: crypto.randomUUID(),
            text: "",
            performer: "",
            note: "",
            duration: 10,
            mode: "auto",
            marker: null,
            upcomingColor: null
        }]
    });

    selectedScript = project.scripts.length - 1;
    selectedCue = 0;

    stopPlayback();
    renderAll();
    markUnsaved();
};

$("addCue").onclick = () => {
    currentScript().cues.push({
        id: crypto.randomUUID(),
        text: "",
        performer: "",
        note: "",
        duration: 10,
        mode: "auto",
        marker: null,
        upcomingColor: null
    });

    selectedCue = currentScript().cues.length - 1;

    renderAll();
    markUnsaved();
};

$("deleteScript").onclick = () => {
    if (project.scripts.length === 1) {
        alert("The project must have at least one script.");
        return;
    }

    if (!confirm("Delete this script and all its cues?")) return;

    project.scripts.splice(selectedScript, 1);
    selectedScript = Math.max(0, selectedScript - 1);
    selectedCue = 0;

    stopPlayback();
    renderAll();
    markUnsaved();
};

$("projectTitle").oninput = event => {
    project.title = event.target.value;
    markUnsaved();
};

$("scriptTitle").oninput = event => {
    currentScript().title = event.target.value;
    renderScripts();
    renderLive();
    markUnsaved();
};

$("scriptType").oninput = event => {
    currentScript().type = event.target.value;
    renderScripts();
    renderLive();
    markUnsaved();
};


// SPEED CONTROL

function requestConfirmation(title, message, confirmLabel, action) {
    confirmationAction = action;
    confirmationReturnFocus = document.activeElement;
    $("confirmationTitle").textContent = title;
    $("confirmationMessage").textContent = message;
    $("confirmConfirmation").textContent = confirmLabel;
    $("confirmationDialog").hidden = false;
    $("confirmConfirmation").focus();
}

function closeConfirmation(confirmed) {
    const action = confirmationAction;
    const returnFocus = confirmationReturnFocus;
    confirmationAction = null;
    confirmationReturnFocus = null;
    $("confirmationDialog").hidden = true;

    if (confirmed && action) action();
    if (returnFocus?.isConnected) returnFocus.focus();
}

function setPlaybackSpeed(nextSpeed) {
    const now = performance.now();
    if (running) advancePlaybackTo(now);

    speed = Math.max(0.5, Math.min(1.5, nextSpeed));
    if (running) playbackAnchor = now;

    const dialValue = Math.round((speed - 1) * 100);
    $("speedDial").value = dialValue;
    const fullscreenDial = $("fullscreenSpeedDial");
    if (fullscreenDial) fullscreenDial.value = dialValue;
    $("speedValue").textContent = `${speed.toFixed(2)}×`;
    $("fullscreenSpeedValue").textContent = `${speed.toFixed(2)}×`;
    renderLive();
    schedulePlayback();
}

$("speedDial").oninput = event => {
    const value = Number(event.target.value);
    setPlaybackSpeed(1 + value / 100);
};

$("fullscreenSpeedDial").oninput = event => {
    const value = Number(event.target.value);
    setPlaybackSpeed(1 + value / 100);
};

function centerSpeedDials() {
    $("speedDial").value = 0;
    $("fullscreenSpeedDial").value = 0;
}

$("speedDial").onchange = centerSpeedDials;
$("fullscreenSpeedDial").onchange = centerSpeedDials;

$("resetSpeed").onclick = () => setPlaybackSpeed(1);
$("fullscreenResetSpeed").onclick = () => setPlaybackSpeed(1);
$("cancelConfirmation").onclick = () => closeConfirmation(false);
$("confirmConfirmation").onclick = () => closeConfirmation(true);
$("confirmationDialog").onclick = event => {
    if (event.target === $("confirmationDialog")) closeConfirmation(false);
};

$("liveFontSize").oninput = event => {
    setLiveFontSize(Number(event.target.value));
};

$("decreaseLiveFont").onclick = () => {
    setLiveFontSize(liveFontSize - 1);
};

$("increaseLiveFont").onclick = () => {
    setLiveFontSize(liveFontSize + 1);
};


// KEYBOARD SHORTCUTS

document.addEventListener("keydown", event => {
    if (!$("confirmationDialog").hidden) {
        if (event.key === "Escape") {
            event.preventDefault();
            closeConfirmation(false);
        }
        return;
    }

    if (event.key === "Escape" && activeMobileDrawer !== null) {
        closeMobileDrawers();
        return;
    }

    if (["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement?.tagName
    )) return;

    if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
    }

    if (event.key === "ArrowRight") moveCue(1);
    if (event.key === "ArrowLeft") moveCue(-1);

    if (event.key.toLowerCase() === "r") {
        setPlaybackSpeed(1);
    }

    if (event.key === "ArrowUp") {
        setPlaybackSpeed(speed + 0.05);
    }

    if (event.key === "ArrowDown") {
        setPlaybackSpeed(speed - 0.05);
    }

    if (/^[1-9]$/.test(event.key)) {
        const marker = allCues().find(
            cue => Number(cue.marker) === Number(event.key)
        );

        if (marker) {
            jumpToCue(marker.scriptIndex, marker.cueIndex);
        }
    }

    if (event.key === "Home") jumpToCue(0, 0);

    if (event.key === "End") {
        const lastScript = findScriptWithCue(project.scripts.length - 1, -1);
        if (lastScript >= 0) {
            jumpToCue(
                lastScript,
                project.scripts[lastScript].cues.length - 1
            );
        }
    }
});

$("toggleFullscreen").onclick = toggleFullscreen;
document.addEventListener("fullscreenchange", syncFullscreenState);
$("globalReset").onclick = () => {
    requestConfirmation(
        "Reset Global Elapsed Time?",
        "Are you sure you want to reset the total elapsed time to 00:00:00?",
        "Confirm Reset",
        () => resetGlobalTimer(performance.now())
    );
};


// PROJECT IMPORT / EXPORT

async function createNewProject() {
    if (projectDirty && !confirm("There are unsaved changes. Create a new project anyway?")) {
        return;
    }

    stopPlayback();
    project = createBlankProject();
    activeProjectHandle = null;
    bundledProjectLoaded = false;
    projectLoaded = true;
    selectedScript = 0;
    selectedCue = 0;
    elapsed = 0;
    completed = false;
    globalElapsedMs = 0;
    globalElapsedStartedAt = null;
    renderAll();
    markUnsaved();
}

$("saveProject").onclick = saveConnectedProject;

$("saveProjectAs").onclick = saveProjectAs;
$("exportProject").onclick = () => {
    exportProjectJson();
    $("saveStatus").textContent = projectDirty
        ? "Exported JSON · unsaved changes"
        : "Exported JSON backup";
};

$("openProject").onclick = openProjectWithPicker;
$("newProject").onclick = createNewProject;

$("projectFile").onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;

    try {
        if (!await loadProjectFile(file)) {
            event.target.value = "";
            return;
        }
    } catch (error) {
        $("saveStatus").textContent = "Save failed · project not loaded";
        console.error("Could not import project JSON.", error);
        alert(`Could not open project: ${error.message}`);
    }

    event.target.value = "";
};

window.addEventListener("beforeunload", event => {
    if (!projectDirty) return;
    event.preventDefault();
    event.returnValue = "";
});


// INITIALIZE

async function initialize() {
    document.querySelector(".project-info > summary").addEventListener(
        "click",
        () => {
            projectInfoTouched = true;
        }
    );
    if (window.matchMedia("(max-width: 700px)").matches) {
        document.querySelector(".project-info").removeAttribute("open");
    }
    setMarkerSidebarOpen(false);
    renderAll();
    $("saveStatus").textContent = `Loading ${DEFAULT_PROJECT_NAME}...`;

    try {
        const response = await fetch(
            new URL(DEFAULT_PROJECT_PATH, document.baseURI)
        );
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const loaded = loadProjectData(
            await response.json(),
            DEFAULT_PROJECT_NAME,
            null,
            true
        );
        if (!loaded) {
            $("saveStatus").textContent =
                `Could not load ${DEFAULT_PROJECT_NAME} · unsaved changes preserved`;
        }
    } catch (error) {
        $("saveStatus").textContent =
            `Default project failed to load · ${error.message}`;
        console.error(`Could not load ${DEFAULT_PROJECT_NAME}.`, error);
    }
}

initialize();
