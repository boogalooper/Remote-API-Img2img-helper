#target photoshop
/*
// BEGIN__HARVEST_EXCEPTION_ZSTRING
<javascriptresource>
<name>Remote API img2img helper</name>
<eventid>03c3cc32-600d-4e47-ad5c-2b11c0f5f176</eventid>
<terminology><![CDATA[<< /Version 1
                        /Events <<
                        /03c3cc32-600d-4e47-ad5c-2b11c0f5f176 [(Remote API img2img helper) <<
                            /recordSettingsToAction [(recorded settings) /boolean]
                        >>]
                        >>
                      >> ]]></terminology>
</javascriptresource>
// END__HARVEST_EXCEPTION_ZSTRING
*/

$.localize = true;

var APP = {
    name: "Remote API img2img helper",
    uuid: "03c3cc32-600d-4e47-ad5c-2b11c0f5f176",
    settingsFile: "Remote API img2img helper.desc",
    tempFolder: "Remote API img2img helper",
    generatedLayerName: "generated image",
    dialogEnvKey: "remoteApiImg2imgHelperDialogMode",
    cancelToken: "__REMOTE_API_IMG2IMG_HELPER_CANCELLED__",
    xmp: {
        namespace: "http://ns.remote-api-img2img-helper.local/generation/1.0/",
        prefix: "RemoteApiImg2imgHelper:",
        property: "generationSettings"
    }
},
    VER = "0.1",
    SETTINGS_DATA_VERSION = 1,
    ACTION_DATA_VERSION = 3,
    // Отладочный флаг должен оставаться false в рабочей сборке. При true
    // главное окно открывается всегда, независимо от сохранённого тихого режима.
    DEBUG_FIRST_LAUNCH_WITH_INTERFACE = false,
    API_FILE = "api-img2img",
    API_HOST = "127.0.0.1",
    API_PORT_SEND = 6380,
    API_PORT_LISTEN = 6381,
    API_PROTOCOL = 1,
    START_TIMEOUT = 30 * 60 * 1000,
    SHORT_TIMEOUT = 8000,
    TRANSLATE_TIMEOUT = 10 * 60 * 1000,
    GENERATION_PREPARE_SEGMENT = 20,
    GENERATION_RUN_SEGMENT = 80,
    PROGRESS_TASK_RANGE = 40,
    REFERENCE_IMAGE_FILTER = "JPEG/PNG/WebP:*.jpg;*.jpeg;*.png;*.webp",
    startupStartedAt = (new Date()).getTime(),
    s2t = stringIDToTypeID,
    t2s = typeIDToStringID,
    descriptorCodec = new DescriptorCodec(),
    presets = new Presets(),
    cfg = new Config(),
    api = new BridgeApi(),
    generationProgress = new GenerationProgress(),
    generation = new GenerationRuntime(),
    action = new ActionRuntime(),
    ui = new UI(),
    generationTimings = new Delay(),
    str = new Locale(),
    apl = new AM("application"),
    doc = new AM("document"),
    lr = new AM("layer"),
    layerMetadata = new LayerMetadata(),
    isDirty = false,
    initialState = null,
    generationResultPlaced = false,
    startupProgress = null,
    isCancelled = false,
    actionPlaybackMode = false,
    actionUsesRecordedSettings = false,
    globalSettings = null,
    settingsReady = false,
    skipSettingsSaveOnError = false,
    keyboardState = ScriptUI.environment.keyboardState;

if (keyboardState.shiftKey && action.getPlaybackParameterCount() != 1) $.setenv(APP.dialogEnvKey, "true");
if (action.hasInterfaceArgument()) $.setenv(APP.dialogEnvKey, "true");
try { init(); }
catch (e) {
    if (startupProgress) { try { startupProgress.close(); } catch (_) { } startupProgress = null; }
    if (String(e.message) == APP.cancelToken) {
        api.interrupt(generationProgress.getRequestId());
        isCancelled = true;
    } else {
        var settingsSaveError = (generationResultPlaced || skipSettingsSaveOnError) ? "" : action.saveAfterError(),
            errorText = APP.name + "\n\n" + errorMessageText(e) +
                (e.line ? "\n\n" + cardText(str.jsxLine) + e.line : "");
        if (settingsSaveError) errorText += "\n\n" + cardText(str.errSettingsSaveAfterError) +
            "\n" + settingsSaveError;
        ui.showErrorMessage(errorText, APP.name);
        isCancelled = false;
    }
    $.setenv(APP.dialogEnvKey, "true");
}
finally { restoreInitialDocumentState(); }
isCancelled ? "cancel" : undefined;

function restoreInitialDocumentState() {
    if (generationResultPlaced || !initialState || !app.documents.length) return;
    try { app.activeDocument.activeHistoryState = initialState; }
    catch (_) { }
}

function errorMessageText(value) {
    if (value === undefined || value === null) return "";
    if (value.message !== undefined) return String(value.message);
    if (typeof value == "object" && (value.ru !== undefined || value.en !== undefined || value.label !== undefined)) return cardText(value);
    return String(value);
}

function cardText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value != "object") return String(value);
    var locale = String($.locale || "").toLowerCase();
    if (locale.indexOf("ru") === 0 && value.ru !== undefined) return String(value.ru);
    if (value.en !== undefined) return String(value.en);
    if (value.ru !== undefined) return String(value.ru);
    if (value.label !== undefined) return cardText(value.label);
    return String(value);
}

function init() {
    if (!app.documents.length) return;
    initialState = app.activeDocument.activeHistoryState;
    if (doc.getProperty("mode").value != "RGBColor") throw new Error(cardText(str.errMode));

    var playbackCount = action.getPlaybackParameterCount(),
        forceDialog = action.hasInterfaceArgument(),
        settingsWarnings = [];
    actionPlaybackMode = action.isPlayback(playbackCount);
    if (actionPlaybackMode) {
        // При playback сначала всегда загружается актуальный глобальный DESC.
        // Action не является отдельной конфигурацией скрипта: он может только
        // наложить снимок выбранной модели поверх данных из DESC.
        globalSettings = new Config();
        globalSettings.load();
        settingsWarnings = settingsWarnings.concat(globalSettings.consumeLoadWarnings());
        cfg.copyAllDataFrom(globalSettings);
        actionUsesRecordedSettings = action.getRecordedSettingsMode();
        if (actionUsesRecordedSettings) cfg.loadModelFromAction();
    } else {
        cfg.load();
        settingsWarnings = settingsWarnings.concat(cfg.consumeLoadWarnings());
        if (playbackCount == 1) $.setenv(APP.dialogEnvKey, "true");
    }
    settingsReady = true;
    cfg.cleanReferenceHistory();

    var environmentMode = DEBUG_FIRST_LAUNCH_WITH_INTERFACE ? null : $.getenv(APP.dialogEnvKey),
        showInterface = DEBUG_FIRST_LAUNCH_WITH_INTERFACE || forceDialog || environmentMode == "true" ||
            (actionPlaybackMode ? app.playbackDisplayDialogs == DialogModes.ALL : environmentMode == null),
        selection = { result: false, bounds: null, sourceBounds: null, previousGeneration: null, junk: null, flattenedSource: null };

    app.activeDocument.suspendHistory(localize(str.historyCheckSelection), "checkSelection(selection)");
    if (!selection.result) return;

    try {
        var apiResponsive = false;
        if (api.isRunning()) {
            try { api.ping(null, 1000); apiResponsive = true; } catch (_) { }
        }
        if (!apiResponsive) {
            startupProgress = ui.createStartupProgress(str.progressStartPython, START_TIMEOUT);
            startupProgress.show();
        }
        api.initialize(startupProgress);
        if (startupProgress) startupProgress.setStage(str.progressHandshake, 25);
        var initial = api.handshake(startupProgress),
            catalog = initial && initial.catalog ? initial.catalog : { providers: [], models: [], invalid_cards: [] };
        if (actionPlaybackMode && actionUsesRecordedSettings) validateRecordedActionSelection(catalog);
        var selectionChanged = normalizeCatalogSelection(catalog),
            notices = settingsWarnings.slice(0),
            responseSeconds = Math.round((((new Date()).getTime() - startupStartedAt) / 1000) * 100) / 100;
        if (catalog.invalid_cards instanceof Array) {
            for (var i = 0; i < catalog.invalid_cards.length; i++) {
                var invalid = catalog.invalid_cards[i];
                notices.push(cardText(str.invalidCard) + "\n" + invalid.file + "\n" + invalid.message);
            }
        }
        if (selectionChanged || notices.length || !hasProviderCredential(cfg.selectedProvider)) {
            showInterface = true;
            $.setenv(APP.dialogEnvKey, "true");
        }
        if (startupProgress) { startupProgress.complete(); startupProgress.close(); startupProgress = null; }
        initial.catalog = catalog;
        initial.notices = notices;

        if (showInterface) {
            var res = mainDialog(selection, initial, responseSeconds);
            if (!res || res.cancelled) {
                if (res && res.saveSettings) action.saveAcceptedSettings();
                else if (!actionPlaybackMode) cfg.save();
                $.setenv(APP.dialogEnvKey, "true");
                isCancelled = true;
                return;
            }
            action.saveAcceptedSettings();
            $.setenv(APP.dialogEnvKey, "false");
            generation.run(selection, res.provider, res.model, res.profile);
            return;
        }

        var provider = findProvider(catalog, cfg.selectedProvider),
            model = findModel(catalog, cfg.selectedModel),
            profile = cfg.getModelProfile(cfg.selectedModel, model);
        if (!provider || !model || model.provider != provider.id || !hasProviderCredential(provider.id)) {
            $.setenv(APP.dialogEnvKey, "true");
            throw new Error(cardText(str.errSilentSettings));
        }
        if (!actionPlaybackMode) cfg.saveToAction();
        generation.run(selection, provider, model, profile);
    } finally {
        if (startupProgress) { try { startupProgress.close(); } catch (_) { } startupProgress = null; }
    }
}

function findProvider(catalog, id) {
    var items = catalog && catalog.providers instanceof Array ? catalog.providers : [];
    for (var i = 0; i < items.length; i++) if (String(items[i].id) == String(id)) return items[i];
    return null;
}
function findModel(catalog, id) {
    var items = catalog && catalog.models instanceof Array ? catalog.models : [];
    for (var i = 0; i < items.length; i++) if (String(items[i].id) == String(id)) return items[i];
    return null;
}
function modelsForProvider(catalog, providerId) {
    var source = catalog && catalog.models instanceof Array ? catalog.models : [], res = [];
    for (var i = 0; i < source.length; i++) if (String(source[i].provider) == String(providerId)) res.push(source[i]);
    return res;
}
function validateRecordedActionSelection(catalog) {
    var providerId = String(cfg.selectedProvider || ""),
        modelId = String(cfg.selectedModel || ""),
        provider = findProvider(catalog, providerId),
        model = findModel(catalog, modelId);
    if (!provider) {
        skipSettingsSaveOnError = true;
        throw new Error(String(cardText(str.errActionProviderMissing)).replace("%1", providerId));
    }
    if (!model || String(model.provider) != providerId) {
        skipSettingsSaveOnError = true;
        throw new Error(String(cardText(str.errActionModelMissing)).replace("%1", modelId));
    }
}

function normalizeCatalogSelection(catalog) {
    var changed = false,
        providers = catalog && catalog.providers instanceof Array ? catalog.providers : [];
    if (!providers.length) throw new Error(cardText(str.errNoProviders));
    var model = findModel(catalog, cfg.selectedModel),
        provider = model ? findProvider(catalog, model.provider) : null;
    // Сохранённая модель имеет приоритет. Провайдер восстанавливается по её
    // карточке, поэтому запуск после перезапуска не сбрасывается на первую модель.
    if (!provider) provider = findProvider(catalog, cfg.selectedProvider);
    if (!provider) { provider = providers[0]; changed = true; }
    if (String(cfg.selectedProvider) != String(provider.id)) {
        cfg.selectedProvider = cfg.data.selectedProvider = provider.id;
        changed = true;
    }
    var models = modelsForProvider(catalog, provider.id);
    if (!models.length) throw new Error(cardText(str.errNoModels));
    if (!model || String(model.provider) != String(provider.id)) {
        model = models[0];
        cfg.selectedModel = cfg.data.selectedModel = model.id;
        changed = true;
    }
    return changed;
}
function hasProviderCredential(providerId) {
    return !!(cfg.providerCredentials && cfg.providerCredentials[settingsKey(providerId)]);
}
function providerCredential(providerId) {
    return cfg.providerCredentials && cfg.providerCredentials[settingsKey(providerId)] || "";
}

function mainDialog(selection, initial, responseSeconds) {
    var catalog = initial.catalog,
        w = new Window("dialog{orientation:'column',alignChildren:['fill','top'],spacing:6,margins:15}"),
        gHeader = w.add("group{orientation:'row',alignChildren:['left','center'],spacing:0,margins:0}"),
        tSelection = gHeader.add("statictext"),
        gHeaderButtons = gHeader.add("group{orientation:'row',alignChildren:['right','center'],spacing:0,margins:0}"),
        bLoad = gHeaderButtons.add("button"),
        bSettings = gHeaderButtons.add("button"),
        providerLabel = w.add("statictext", undefined, str.provider),
        providerList = w.add("dropdownlist"),
        modelLabel = w.add("statictext", undefined, str.model),
        modelList = w.add("dropdownlist"),
        promptLabel = w.add("statictext", undefined, str.prompt),
        promptToolbar = ui.addPresetToolbar(w, ui.contentWidth(), str.promptClear),
        promptEdit = w.add("edittext", undefined, "", { multiline: true, scrollable: true }),
        translateButton = w.add("button", undefined, str.translatePrompt),
        dynamicHost = w.add("group{orientation:'column',alignChildren:['fill','top'],spacing:5,margins:0}"),
        dynamicGroup = null,
        dynamic = {},
        activeModelId = "",
        statusText = w.add("statictext", undefined, "", { multiline: true }),
        okRow = w.add("group{orientation:'row',alignChildren:['center','center'],spacing:10,margins:[0,8,0,0]}"),
        bOk = okRow.add("button", undefined, str.generate, { name: "ok" }),
        result = null,
        promptPresetStore = cfg.getPromptPresetStore('positive');

    w.text = APP.name + " v" + VER + " — " + responseSeconds + "s";
    ui.setFixedWidth(w, ui.mainWindowWidth);
    ui.setFixedWidth(gHeader, ui.contentWidth());
    tSelection.alignment = ["fill", "center"];
    gHeaderButtons.alignment = ["right", "center"];
    bLoad.text = "LOAD";
    bLoad.helpTip = str.loadLayerMetadata;
    bSettings.text = "⚙";
    bSettings.helpTip = str.scriptSettings;
    ui.setFixedWidth(bLoad, ui.loadMetadataButtonWidth);
    ui.setFixedWidth(bSettings, ui.mainSettingsButtonWidth);
    ui.setFixedWidth(providerList, ui.contentWidth());
    ui.setFixedWidth(modelList, ui.contentWidth());
    promptEdit.preferredSize = [ui.contentWidth(), 92];
    ui.setFixedWidth(promptToolbar.row, ui.contentWidth());
    translateButton.preferredSize.width = ui.contentWidth();
    statusText.preferredSize.width = ui.contentWidth();
    updateSelectionSummary();
    fillProviders(cfg.selectedProvider);
    fillModels(cfg.selectedModel);
    fillPromptPresets();
    rebuildDynamic(true);
    updateMetadataButton();
    updatePromptPresetState();
    updateGenerateState();

    if (initial.notices && initial.notices.length) w.onShow = function () {
        ui.showWarningMessage(initial.notices.join("\n\n"), APP.name);
        initial.notices = [];
    };

    providerList.onChange = function () {
        saveCurrent();
        if (!this.selection) return;
        cfg.selectedProvider = cfg.data.selectedProvider = this.selection.itemId;
        fillModels("");
        isDirty = false;
        rebuildDynamic(true);
    };
    modelList.onChange = function () {
        saveCurrent();
        if (!this.selection) return;
        cfg.selectedModel = cfg.data.selectedModel = this.selection.itemId;
        isDirty = false;
        rebuildDynamic(true);
    };
    promptEdit.onChanging = function () { updateGenerateState(); updatePromptPresetState(); };
    promptEdit.onChange = function () { var p = currentProfile(); if (p) p.prompt = this.text; updateGenerateState(); updatePromptPresetState(); };
    translateButton.onClick = function () {
        var source = trimText(promptEdit.text);
        if (!source) return;
        try {
            var translated = ui.runWithPaletteProgress(str.progressTranslate, function (progress) {
                return api.translate(source.replace(/\r?\n/g, " "), progress);
            });
            if (translated && String(translated).length) {
                promptEdit.text = translated;
                var p = currentProfile(); if (p) p.prompt = translated;
            } else ui.showErrorMessage(str.errTranslate);
        } catch (e) { ui.showErrorMessage(e && e.message ? e.message : str.errTranslate); }
        updateGenerateState(); updatePromptPresetState();
    };
    promptToolbar.dropdown.onChange = function () {
        var presetText = selectedPromptPresetText();
        promptEdit.text = presets.applyPrompt('positive', promptEdit.text, presetText);
        var p = currentProfile(); if (p) p.prompt = promptEdit.text;
        updateGenerateState(); updatePromptPresetState();
    };
    promptToolbar.refresh.onClick = function () {
        promptEdit.text = ''; var p = currentProfile(); if (p) p.prompt = ''; 
        updateGenerateState(); updatePromptPresetState();
    };
    promptToolbar.add.onClick = function () {
        var currentName = promptToolbar.dropdown.selection ? promptToolbar.dropdown.selection.text : cardText(str.presetDefault),
            name = prompt(cardText(str.presetNamePrompt), currentName + cardText(str.presetCopy), cardText(str.presetNew));
        name = name == null ? '' : String(name).replace(/^\s+|\s+$/g, '');
        if (!name) return;
        if (String(name).toLowerCase() == String(cardText(str.presetDefault)).toLowerCase()) { alert(cardText(str.errDefaultPreset)); return; }
        if (promptPresetStore.hasOwnProperty(name) && !confirm(String(cardText(str.errPreset)).replace('%1', name), false, cardText(str.presetNew))) return;
        promptPresetStore[name] = presets.promptText('positive', promptEdit.text);
        fillPromptPresets(name); updatePromptPresetState();
    };
    promptToolbar.save.onClick = function () {
        if (!promptToolbar.dropdown.selection || promptToolbar.dropdown.selection.index == 0) return;
        promptPresetStore[promptToolbar.dropdown.selection.text] = presets.promptText('positive', promptEdit.text);
        updatePromptPresetState();
    };
    promptToolbar.remove.onClick = function () {
        if (!promptToolbar.dropdown.selection || promptToolbar.dropdown.selection.index == 0) return;
        var index = promptToolbar.dropdown.selection.index, name = promptToolbar.dropdown.selection.text;
        if (!confirm(cardText(str.presetDeleteConfirmA) + name + cardText(str.presetDeleteConfirmB))) return;
        delete promptPresetStore[name];
        fillPromptPresets(null, Math.max(0, index - 1));
        updatePromptPresetState();
    };
    bSettings.onClick = function () {
        saveCurrent();
        var selectedProviderBeforeSettings = cfg.selectedProvider,
            selectedModelBeforeSettings = cfg.selectedModel,
            resizeDirtyBeforeSettings = isDirty;
        if (showGlobalSettings(catalog)) {
            // Глобальные настройки применяются к cfg без замены modelProfiles.
            // Поэтому текущая модель и её профиль остаются теми же, а повторное
            // заполнение dropdownlist (которое запускало onChange) не требуется.
            cfg.selectedProvider = cfg.data.selectedProvider = selectedProviderBeforeSettings;
            cfg.selectedModel = cfg.data.selectedModel = selectedModelBeforeSettings;
            isDirty = resizeDirtyBeforeSettings;
            rebuildDynamic(false);
        }
    };
    bLoad.onClick = function () {
        var metadata = layerMetadata.read();
        if (!metadata) { updateMetadataButton(); return; }
        try {
            var metadataProvider = findProvider(catalog, metadata.provider_id),
                metadataModel = findModel(catalog, metadata.model_id);
            if (!metadataProvider || !metadataModel)
                throw new Error(cardText(str.errMetadataModelMissing));
            cfg.selectedProvider = cfg.data.selectedProvider = metadata.provider_id;
            cfg.selectedModel = cfg.data.selectedModel = metadata.model_id;
            var profile = cfg.getModelProfile(cfg.selectedModel, metadataModel);
            if (isObjectMap(metadata.profile)) mergeObject(profile, metadata.profile);
            if (metadata.prompt !== undefined) profile.prompt = String(metadata.prompt || "");
            promptEdit.text = profile.prompt || "";
            fillPromptPresets(); updatePromptPresetState();
            fillProviders(cfg.selectedProvider);
            fillModels(cfg.selectedModel);
            isDirty = false;
            rebuildDynamic(true);
        } catch (e) { ui.showErrorMessage(e); }
        updateMetadataButton();
    };
    bOk.onClick = function () {
        try {
            saveCurrent();
            var provider = findProvider(catalog, cfg.selectedProvider),
                model = findModel(catalog, cfg.selectedModel),
                profile = cfg.getModelProfile(cfg.selectedModel, model);
            if (!provider || !model || model.provider != provider.id) throw new Error(cardText(str.errNoModelSelected));
            if (!trimText(profile.prompt)) throw new Error(cardText(str.errPromptEmpty));
            if (!hasProviderCredential(provider.id)) throw new Error(cardText(str.errApiKeyMissing));
            result = { cancelled: false, provider: provider, model: model, profile: profile };
            w.close(1);
        } catch (e) { ui.showErrorMessage(e); }
    };
    w.onClose = function () {
        if (!result) {
            saveCurrent();
            $.setenv(APP.dialogEnvKey, "true");
            result = { cancelled: true, saveSettings: true };
        }
        return true;
    };

    w.layout.layout(true);
    w.preferredSize.width = w.minimumSize.width = w.maximumSize.width = ui.mainWindowWidth;
    ui.enableHoverFocus(w);
    w.center(); w.show(); return result;

    function selectedPromptPresetText() {
        return promptToolbar.dropdown.selection && promptToolbar.dropdown.selection.index > 0 ? String(promptPresetStore[promptToolbar.dropdown.selection.text] || '') : '';
    }
    function updatePromptPresetState() {
        var cur = presets.promptText('positive', promptEdit.text),
            stored = selectedPromptPresetText(),
            changed = cur != stored,
            customPreset = !!(promptToolbar.dropdown.selection && promptToolbar.dropdown.selection.index > 0);
        promptToolbar.remove.enabled = customPreset;
        promptToolbar.save.enabled = customPreset && changed;
        promptToolbar.refresh.enabled = changed;
        promptToolbar.add.enabled = cur.length > 0;
        translateButton.enabled = cur.length > 0;
    }
    function fillPromptPresets(selectName, selectIndex) {
        promptToolbar.dropdown.removeAll();
        promptToolbar.dropdown.add('item', cardText(str.presetDefault));
        var names = [], key, i, sel = 0;
        for (key in promptPresetStore) if (promptPresetStore.hasOwnProperty(key)) names.push(key);
        names.sort(function (a, b) { a = String(a).toLowerCase(); b = String(b).toLowerCase(); return a == b ? 0 : (a > b ? 1 : -1); });
        for (i = 0; i < names.length; i++) {
            promptToolbar.dropdown.add('item', names[i]);
            if (names[i] == selectName) sel = i + 1;
        }
        if (selectName == null && selectIndex != null) sel = Math.min(Math.max(0, selectIndex), promptToolbar.dropdown.items.length - 1);
        promptToolbar.dropdown.selection = sel;
    }
    function updateSelectionSummary() {
        var b = selection.bounds;
        tSelection.text = cardText(str.selection) + b.width + "x" + b.height +
            " (" + roundTo(b.width * b.height / 1000000, 2) + " MP)";
    }
    function updateMetadataButton() {
        var has = layerMetadata.read() != null;
        bLoad.visible = bLoad.enabled = has;
        ui.setFixedWidth(bLoad, has ? ui.loadMetadataButtonWidth : 0);
    }
    function fillProviders(selectedId) {
        providerList.removeAll();
        var providers = catalog.providers || [], selected = 0;
        for (var i = 0; i < providers.length; i++) {
            var item = providerList.add("item", cardText(providers[i].label || providers[i].id));
            item.itemId = providers[i].id;
            if (String(item.itemId) == String(selectedId)) selected = i;
        }
        providerList.selection = providers.length ? selected : null;
        if (providerList.selection) cfg.selectedProvider = cfg.data.selectedProvider = providerList.selection.itemId;
    }
    function fillModels(selectedId) {
        modelList.removeAll();
        var providerId = providerList.selection ? providerList.selection.itemId : cfg.selectedProvider,
            models = modelsForProvider(catalog, providerId), selected = 0;
        for (var i = 0; i < models.length; i++) {
            var item = modelList.add("item", cardText(models[i].label || models[i].id));
            item.itemId = models[i].id;
            if (String(item.itemId) == String(selectedId)) selected = i;
        }
        modelList.selection = models.length ? selected : null;
        if (modelList.selection) cfg.selectedModel = cfg.data.selectedModel = modelList.selection.itemId;
    }
    function saveCurrent() {
        // onChange fires after ScriptUI has already changed dropdown.selection.
        // Save values to the model whose controls are currently shown,
        // not to the newly selected model.
        var profileId = activeModelId || cfg.selectedModel,
            profile = profileId ? cfg.getModelProfile(profileId, findModel(catalog, profileId)) : null;
        if (profile) {
            profile.prompt = promptEdit.text;
            if (profile.autoResize && isDirty) profile.resizeDirty = true;
        }
        if (profile && dynamic.aspectRatio) profile.aspectRatio = dynamic.aspectRatio.getValue();
        if (profile && dynamic.quality) profile.quality = dynamic.quality.getValue();
        if (providerList.selection) cfg.selectedProvider = cfg.data.selectedProvider = providerList.selection.itemId;
        if (modelList.selection) cfg.selectedModel = cfg.data.selectedModel = modelList.selection.itemId;
    }
    function currentProfile() {
        var profileId = activeModelId || cfg.selectedModel;
        return profileId ? cfg.getModelProfile(profileId, findModel(catalog, profileId)) : null;
    }
    function rebuildDynamic(resetAutoResizeOverride) {
        if (dynamicGroup) { try { dynamicGroup.visible = false; dynamicHost.remove(dynamicGroup); } catch (_) { } }
        dynamicGroup = dynamicHost.add("group{orientation:'column',alignChildren:['fill','top'],spacing:5,margins:0}");
        ui.setFixedWidth(dynamicGroup, ui.contentWidth());
        dynamic = {};
        var model = findModel(catalog, cfg.selectedModel);
        activeModelId = model ? String(model.id) : "";
        if (!model) { updateGenerateState(); return; }
        var profile = cfg.getModelProfile(model.id, model);
        if (resetAutoResizeOverride && profile.autoResize) profile.resizeDirty = false;
        isDirty = !!(profile.autoResize && profile.resizeDirty);
        promptEdit.text = profile.prompt || "";
        ui.addResizeControl(dynamicGroup, selection.bounds, profile, model);
        var controls = model.controls || {};
        if (controls.aspect_ratio) dynamic.aspectRatio = ui.addOptionControl(dynamicGroup, controls.aspect_ratio, profile.aspectRatio);
        if (controls.quality) dynamic.quality = ui.addOptionControl(dynamicGroup, controls.quality, profile.quality);
        var referenceCapability = model.capabilities && model.capabilities.reference;
        if (referenceCapability && referenceCapability.supported) ui.addReferenceControl(dynamicGroup, profile);
        try { dynamicGroup.layout.layout(true); dynamicHost.layout.layout(true); w.layout.layout(true); } catch (_) { }
        updatePromptPresetState();
        updateGenerateState();
    }
    function updateGenerateState() {
        var provider = findProvider(catalog, cfg.selectedProvider),
            model = findModel(catalog, cfg.selectedModel),
            keyReady = provider && hasProviderCredential(provider.id),
            promptReady = trimText(promptEdit.text).length > 0;
        if (!provider || !model) statusText.text = cardText(str.noModelAvailable);
        else if (!keyReady) statusText.text = cardText(str.apiKeyRequired);
        else statusText.text = "";
        bOk.enabled = !!provider && !!model && keyReady && promptReady;
    }
}

function showGlobalSettings(catalog) {
    var temp = cloneObj(cfg.data);
    if (!isObjectMap(temp.providerCredentials)) temp.providerCredentials = {};
    if (!temp.resizePresets || !temp.resizePresets.length) temp.resizePresets = cloneObj(presets.defaultResize());
    var w = ui.createDialog({ title: str.scriptSettings, spacing: 8 }),
        credentialsPanel = w.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:6,margins:10}"),
        resizePanel = w.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:5,margins:10}"),
        imagePanel = w.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:5,margins:10}"),
        brushPanel = w.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:5,margins:10}"),
        apiPanel = w.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:5,margins:10}"),
        photoshopPanel = w.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:5,margins:10}"),
        buttonRow = w.add("group{orientation:'row',alignChildren:['center','center'],spacing:10,margins:[0,8,0,0]}"),
        save = buttonRow.add("button", undefined, str.saveChanges, { name: "ok" }),
        cancel = buttonRow.add("button", undefined, str.cancel, { name: "cancel" }),
        accepted = false;
    credentialsPanel.text = str.apiKeys;
    resizePanel.text = str.resizePresetManagement;
    imagePanel.text = str.imageSettings;
    brushPanel.text = str.brushSettings;
    apiPanel.text = str.apiSettings;
    photoshopPanel.text = str.photoshopSettings;
    ui.setFixedWidth(w, 470);

    var providers = catalog.providers || [], credentialRows = [];
    for (var i = 0; i < providers.length; i++) credentialRows.push(addCredentialRow(providers[i]));

    var resizeEditor = resizePresetEditor(resizePanel, temp),
        flatten = imagePanel.add("checkbox", undefined, str.flatten),
        rasterize = imagePanel.add("checkbox", undefined, str.rasterize),
        keepAspect = imagePanel.add("checkbox", undefined, str.keepAspectRatioDuringPlace),
        selectBrush = brushPanel.add("checkbox", undefined, str.selectBrush),
        opacityControl = ui.addSlider(brushPanel, str.opacity, 1, 100, clamp(Math.round(temp.brushOpacity || 60), 1, 100), {
            displayValue: clamp(Math.round(temp.brushOpacity || 60), 1, 100),
            controlWidth: ui.settingsControlWidth
        }),
        timeoutRow = apiPanel.add("group{orientation:'row',alignChildren:['left','center'],spacing:8,margins:0}"),
        timeoutLabel = timeoutRow.add("statictext", undefined, str.generationTimeout),
        timeoutEdit = timeoutRow.add("edittext", undefined, String(temp.generationTimeout || 1200)),
        recordAction = photoshopPanel.add("checkbox", undefined, str.recordSettingsToAction),
        metadata = photoshopPanel.add("checkbox", undefined, str.writeLayerMetadata);
    flatten.value = !!temp.flatten;
    rasterize.value = !!temp.rasterizeImage;
    keepAspect.value = !!temp.keepAspectRatioDuringPlace;
    selectBrush.value = temp.selectBrush !== false;
    recordAction.value = temp.recordSettingsToAction !== false;
    metadata.value = !!temp.writeLayerMetadata;
    timeoutEdit.characters = 8;
    ui.setFixedWidth(timeoutRow, ui.settingsControlWidth);
    timeoutLabel.alignment = ['fill', 'center'];
    ui.setFixedWidth(timeoutEdit, 70);
    function syncOpacityValue() { opacityControl.valueText.text = String(Math.round(opacityControl.slider.value)); }
    opacityControl.slider.onChanging = syncOpacityValue;
    opacityControl.slider.onChange = syncOpacityValue;

    save.onClick = function () {
        try {
            var timeout = parseInt(timeoutEdit.text, 10);
            if (isNaN(timeout) || timeout < 30 || timeout > 86400) throw new Error(cardText(str.errTimeout));
            if (resizeEditor && resizeEditor.saveActive) resizeEditor.saveActive();
            temp.flatten = flatten.value;
            temp.rasterizeImage = rasterize.value;
            temp.keepAspectRatioDuringPlace = keepAspect.value;
            temp.generationTimeout = timeout;
            temp.recordSettingsToAction = recordAction.value;
            temp.writeLayerMetadata = metadata.value;
            temp.selectBrush = selectBrush.value;
            temp.brushOpacity = clamp(Math.round(opacityControl.slider.value), 1, 100);

            // Применяем только глобальные поля. selectedProvider,
            // selectedModel и modelProfiles остаются в исходном объекте cfg,
            // поэтому сохранение этого окна не может сбросить рабочий профиль.
            cfg.autoResize = cfg.data.autoResize = !!temp.autoResize;
            cfg.resizePresets = cfg.data.resizePresets = cloneObj(temp.resizePresets);
            cfg.flatten = cfg.data.flatten = !!temp.flatten;
            cfg.rasterizeImage = cfg.data.rasterizeImage = !!temp.rasterizeImage;
            cfg.keepAspectRatioDuringPlace = cfg.data.keepAspectRatioDuringPlace = !!temp.keepAspectRatioDuringPlace;
            cfg.recordSettingsToAction = cfg.data.recordSettingsToAction = !!temp.recordSettingsToAction;
            cfg.writeLayerMetadata = cfg.data.writeLayerMetadata = !!temp.writeLayerMetadata;
            cfg.selectBrush = cfg.data.selectBrush = temp.selectBrush !== false;
            cfg.brushOpacity = cfg.data.brushOpacity = temp.brushOpacity;
            cfg.generationTimeout = cfg.data.generationTimeout = temp.generationTimeout;
            cfg.providerCredentials = cfg.data.providerCredentials = cloneObj(temp.providerCredentials || {});
            accepted = true;
            w.close(1);
        } catch (e) { ui.showErrorMessage(e); }
    };
    cancel.onClick = function () { w.close(0); };
    ui.showDialog(w);
    return accepted;

    function resizePresetEditor(parent, tempCfg) {
        if (!tempCfg.resizePresets || !tempCfg.resizePresets.length) tempCfg.resizePresets = cloneObj(presets.defaultResize());
        var toolbar = ui.addPresetToolbar(parent, ui.settingsControlWidth, str.presetRestore),
            presetList = toolbar.dropdown,
            minControl = presetSlider(parent, { title: str.minimumSide, min: 256, max: 4096, value: 512, step: 32, suffix: ' px' }),
            maxControl = presetSlider(parent, { title: str.maximumMp, min: 10, max: 2000, value: 110, step: 10, suffix: ' MP' }),
            minSync = minControl.slider.onChange,
            maxSync = maxControl.slider.onChange;
        minControl.slider.onChange = function () { minSync.call(this); checkIntegrity(); };
        maxControl.slider.onChange = function () { maxSync.call(this); checkIntegrity(); };
        toolbar.refresh.onClick = function () { loadSelection(); };
        toolbar.add.onClick = function () {
            var cur = readPreset(), defaultName = presetList.selection ? tempCfg.resizePresets[presetList.selection.index].name + cardText(str.presetCopy) : cardText(str.resizePresetNew),
                name = prompt(cardText(str.resizePresetPrompt), defaultName, cardText(str.resizePresetTitle));
            name = name == null ? '' : String(name).replace(/^\s+|\s+$/g, '');
            if (!name.length) return;
            var found = presets.findResizeIndex(name, tempCfg.resizePresets);
            if (found >= 0) {
                if (!confirm(String(cardText(str.errResizePreset)).replace('%1', name), false, cardText(str.resizePresetTitle))) return;
                tempCfg.resizePresets[found] = presets.createResize(name, cur.minSide, cur.maxMp);
            } else {
                tempCfg.resizePresets.push(presets.createResize(name, cur.minSide, cur.maxMp));
                found = tempCfg.resizePresets.length - 1;
            }
            refreshList(found);
        };
        toolbar.save.onClick = function () { saveActive(true); };
        toolbar.remove.onClick = function () {
            if (!presetList.selection || presets.isProtectedResize(tempCfg.resizePresets[presetList.selection.index].name)) return;
            tempCfg.resizePresets.splice(presetList.selection.index, 1);
            refreshList(0);
        };
        presetList.onChange = function () { loadSelection(); };
        refreshList(0);
        function refreshList(index) {
            presetList.removeAll();
            for (var i = 0; i < tempCfg.resizePresets.length; i++) presetList.add('item', tempCfg.resizePresets[i].name);
            if (!presetList.items.length) return;
            if (index == null || index < 0) index = 0;
            presetList.selection = Math.min(index, presetList.items.length - 1);
            loadSelection();
        }
        function loadSelection() {
            if (!presetList.selection) { checkIntegrity(); return; }
            var preset = tempCfg.resizePresets[presetList.selection.index];
            minControl.slider.value = preset.minSide;
            maxControl.slider.value = preset.maxMp * 100;
            minControl.syncValue(true);
            maxControl.syncValue(true);
            checkIntegrity();
        }
        function checkIntegrity() {
            if (!presetList.selection) { toolbar.refresh.enabled = toolbar.save.enabled = toolbar.remove.enabled = false; return; }
            var cur = readPreset(), preset = tempCfg.resizePresets[presetList.selection.index], changed = cur.minSide != preset.minSide || cur.maxMp != preset.maxMp;
            toolbar.refresh.enabled = toolbar.save.enabled = changed;
            toolbar.remove.enabled = tempCfg.resizePresets.length > 1 && !presets.isProtectedResize(preset.name);
        }
        function readPreset() { return { minSide: Math.round(minControl.slider.value / 32) * 32, maxMp: Math.round(maxControl.slider.value / 10) * 10 / 100 }; }
        function saveActive(refresh) {
            if (!presetList.selection) return false;
            var cur = readPreset(), index = presetList.selection.index, preset = tempCfg.resizePresets[index];
            if (cur.minSide == preset.minSide && cur.maxMp == preset.maxMp) return false;
            tempCfg.resizePresets[index] = presets.createResize(preset.name, cur.minSide, cur.maxMp);
            if (refresh) refreshList(index); else checkIntegrity();
            return true;
        }
        return { saveActive: function () { return saveActive(false); } };
    }
    function presetSlider(parent, options) {
        var group = parent.add("group{orientation:'column',alignChildren:['fill','top'],spacing:0,margins:0}"),
            titleGroup = group.add("group{orientation:'row',alignChildren:['left','center'],spacing:5,margins:0}");
        ui.setFixedWidth(group, ui.settingsControlWidth);
        ui.setFixedWidth(titleGroup, ui.settingsControlWidth);
        var label = titleGroup.add('statictext'), valueText = titleGroup.add('statictext{justify:"right"}'), slider = group.add('slider'), control = { slider: slider, value: valueText, suffix: options.suffix, step: options.step, decimal: options.suffix == ' MP', snappedValue: null, pointerActive: false };
        label.text = cardText(options.title); label.alignment = ['fill', 'center']; valueText.alignment = ['right', 'center'];
        ui.setFixedWidth(valueText, ui.sliderValueWidth);
        ui.setFixedWidth(slider, ui.settingsControlWidth);
        slider.minvalue = options.min; slider.maxvalue = options.max; slider.value = options.value;
        try { slider.addEventListener('mousedown', function () { control.pointerActive = true; }); } catch (_) { }
        function syncValue(reset) { syncPresetSlider(control, !!reset, !control.pointerActive); }
        slider.onChanging = function () { syncValue(false); };
        slider.onChange = function () { syncValue(false); control.pointerActive = false; };
        control.syncValue = syncValue; syncValue(true); return control;
    }
    function syncPresetSlider(control, reset, forceStep) {
        var raw = Number(control.slider.value), previous = reset ? null : control.snappedValue, value = Math.round(raw / control.step) * control.step;
        if (forceStep && previous !== null && value == previous && raw != previous) value = previous + (raw > previous ? control.step : -control.step);
        value = clamp(value, control.slider.minvalue, control.slider.maxvalue);
        control.slider.value = value; control.snappedValue = value; control.value.text = (control.decimal ? value / 100 : value) + control.suffix;
    }
    function addCredentialRow(provider) {
        var row = credentialsPanel.add("group{orientation:'row',alignChildren:['left','center'],spacing:6,margins:0}"),
            label = row.add("statictext", undefined, cardText(provider.label || provider.id)),
            status = row.add("statictext"),
            setButton = row.add("button"),
            deleteButton = row.add("button", undefined, str.deleteKey);
        ui.setFixedWidth(row, ui.settingsControlWidth);
        label.preferredSize.width = 115;
        status.preferredSize.width = 125;
        setButton.preferredSize.width = 80;
        deleteButton.preferredSize.width = 70;
        function encrypted() { return temp.providerCredentials[settingsKey(provider.id)] || ""; }
        function update() {
            status.text = encrypted() ? cardText(str.keyConfigured) : cardText(str.keyMissing);
            setButton.text = encrypted() ? cardText(str.changeKey) : cardText(str.setKey);
            deleteButton.enabled = !!encrypted();
        }
        setButton.onClick = function () {
            var secret = ui.promptSecret(cardText(provider.label || provider.id));
            if (secret === null) return;
            try {
                var response = api.encryptCredential(provider.id, secret);
                secret = "";
                if (!response || !response.encrypted) throw new Error(cardText(str.errEncryptKey));
                temp.providerCredentials[settingsKey(provider.id)] = response.encrypted;
                update();
            } catch (e) { secret = ""; ui.showErrorMessage(e); }
        };
        deleteButton.onClick = function () {
            delete temp.providerCredentials[settingsKey(provider.id)];
            update();
        };
        update();
        return row;
    }
}



function UI() {
    var self = this;
    this.mainWindowWidth = 390;
    // Внутренняя ширина панели окна 470 px с полями 15/10 px.
    // Отдельная константа не должна зависеть от ширины главного окна.
    this.settingsControlWidth = 420;
    this.presetButtonWidth = 25;
    this.mainSettingsButtonWidth = 27;
    this.loadMetadataButtonWidth = 54;
    this.sliderValueWidth = 65;
    this.autoResizeCheckboxWidth = 20;
    this.contentWidth = function () { return Math.max(250, self.mainWindowWidth - 30); };
    this.setFixedWidth = function (control, width) {
        width = Math.max(0, Number(width) || 0);
        control.preferredSize.width = control.minimumSize.width = control.maximumSize.width = width;
        return control;
    };
    this.addToolbarRow = function (parent, totalWidth, buttonCount) {
        buttonCount = Math.max(0, parseInt(buttonCount, 10) || 0);
        totalWidth = Math.max(self.presetButtonWidth * buttonCount + 100, Number(totalWidth) || self.contentWidth());
        var buttonBlockWidth = self.presetButtonWidth * buttonCount,
            dropdownWidth = Math.max(100, totalWidth - buttonBlockWidth),
            row = parent.add("group{orientation:'row',alignChildren:['left','center'],spacing:0,margins:0}"),
            dropdown = row.add('dropdownlist'),
            buttons = row.add("group{orientation:'row',alignChildren:['left','center'],spacing:0,margins:0}"),
            controls = [];
        self.setFixedWidth(row, totalWidth);
        dropdown.alignment = ['left', 'center'];
        self.setFixedWidth(dropdown, dropdownWidth);
        buttons.alignment = ['right', 'center'];
        self.setFixedWidth(buttons, buttonBlockWidth);
        for (var i = 0; i < buttonCount; i++) {
            var button = buttons.add('button');
            self.setFixedWidth(button, self.presetButtonWidth);
            controls.push(button);
        }
        return { row: row, dropdown: dropdown, buttons: buttons, controls: controls };
    };
    this.addPresetToolbar = function (parent, totalWidth, refreshHelp) {
        var toolbar = self.addToolbarRow(parent, totalWidth, 4),
            controls = toolbar.controls,
            refresh = controls[0],
            add = controls[1],
            save = controls[2],
            remove = controls[3],
            symbols = [str.presetRefreshButton, str.presetAddButton, str.presetSaveButton, str.presetDeleteButton],
            tips = [refreshHelp || str.presetRestore, str.presetAdd, str.presetSave, str.presetDelete];
        for (var i = 0; i < controls.length; i++) {
            controls[i].text = cardText(symbols[i]);
            controls[i].helpTip = cardText(tips[i]);
        }
        return { row: toolbar.row, dropdown: toolbar.dropdown, refresh: refresh, add: add, save: save, remove: remove };
    };
    this.createDialog = function (options) {
        options = options || {};
        var spacing = options.spacing === undefined ? 8 : options.spacing,
            margins = options.margins === undefined ? 15 : options.margins,
            dialog = new Window("dialog{orientation:'column',alignChildren:['fill','top'],spacing:" + spacing + ",margins:" + margins + "}");
        dialog.text = cardText(options.title || APP.name);
        return dialog;
    };
    this.showDialog = function (dialog) { self.enableHoverFocus(dialog); dialog.center(); return dialog.show(); };
    this.enableHoverFocus = function (root) {
        function attach(control) {
            if (!control) return;
            var type = "", attached = false;
            try { type = String(control.type || "").toLowerCase(); attached = !!control.__apiImgHoverFocus; } catch (_) { }
            if (!attached && type == "slider" && control.addEventListener) {
                var activate = function () {
                    try { if (control.visible === false || control.enabled === false) return; if (!control.active) control.active = true; } catch (_) { }
                };
                try { control.addEventListener("mouseover", activate); control.addEventListener("mousemove", activate); control.__apiImgHoverFocus = true; } catch (_) { }
            }
            var children = null;
            try { children = control.children; } catch (_) { }
            if (children) for (var i = 0; i < children.length; i++) attach(children[i]);
        }
        attach(root);
    };
    this.showWarningMessage = function (value, title) { alert(errorMessageText(value), title || APP.name, false); };
    this.showErrorMessage = function (value, title) {
        var text = errorMessageText(value), dialogTitle = title || APP.name;
        if (text.length <= 300) { alert(text, dialogTitle, true); return; }
        try { app.beep(); } catch (_) { }
        var w = new Window("dialog{orientation:'column',alignChildren:['fill','top'],spacing:10,margins:15}"),
            heading = w.add("statictext", undefined, str.errorOccurred),
            explanation = w.add("statictext", undefined, str.errorDialogIntro, { multiline: true }),
            details = w.add("panel", undefined, str.errorDetails),
            msg = details.add("edittext", undefined, text, { multiline: true, scrollable: true, readonly: true }),
            buttons = w.add("group{orientation:'row',alignChildren:['center','center'],spacing:10,margins:[0,5,0,0]}"),
            ok = buttons.add("button", undefined, "OK", { name: "ok" });
        w.text = dialogTitle + " — " + cardText(str.errorDialogTitle);
        try { heading.graphics.font = ScriptUI.newFont(heading.graphics.font.name, "BOLD", 15); } catch (_) { }
        explanation.preferredSize.width = 700;
        details.orientation = "column"; details.alignChildren = ["fill", "fill"]; details.margins = 12;
        msg.preferredSize = [700, 360]; msg.minimumSize = [540, 260];
        self.enableHoverFocus(w); w.center(); w.show();
    };
    this.promptSecret = function (providerLabel) {
        var w = self.createDialog({ title: cardText(str.apiKey) + " — " + providerLabel }),
            note = w.add("statictext", undefined, str.apiKeyNote, { multiline: true }),
            edit = w.add("edittext", undefined, "", { noecho: true }),
            row = w.add("group{orientation:'row',alignChildren:['center','center'],spacing:10,margins:[0,8,0,0]}"),
            ok = row.add("button", undefined, "OK", { name: "ok" }),
            cancel = row.add("button", undefined, str.cancel, { name: "cancel" }),
            result = null;
        note.preferredSize.width = 420; edit.preferredSize.width = 420;
        ok.onClick = function () { if (!String(edit.text || "").length) return; result = edit.text; edit.text = ""; w.close(1); };
        cancel.onClick = function () { edit.text = ""; w.close(0); };
        w.onShow = function () { try { edit.active = true; } catch (_) { } };
        self.showDialog(w); return result;
    };
    this.addSlider = function (parent, labelText, min, max, value, options) {
        options = options || {};
        var controlWidth = options.controlWidth || self.contentWidth(),
            valueWidth = options.valueWidth || self.sliderValueWidth,
            titleSpacing = options.titleSpacing === undefined ? 0 : options.titleSpacing,
            titleWidth = options.titleWidth || (controlWidth - valueWidth - titleSpacing),
            group = parent.add("group{orientation:'column',alignChildren:['fill','top'],spacing:0,margins:" + (options.margins || 0) + "}"),
            titleGroup = group.add("group{orientation:'row',alignChildren:['left','center'],spacing:" + titleSpacing + ",margins:0}"),
            title = titleGroup.add("statictext"),
            valueText = titleGroup.add("statictext{justify:'right'}"),
            slider = group.add("slider");
        self.setFixedWidth(group, controlWidth);
        self.setFixedWidth(titleGroup, controlWidth);
        self.setFixedWidth(title, titleWidth);
        self.setFixedWidth(valueText, valueWidth);
        self.setFixedWidth(slider, controlWidth);
        slider.minvalue = min;
        slider.maxvalue = max;
        slider.value = value;
        title.text = cardText(labelText);
        valueText.text = options.displayValue !== undefined ? options.displayValue : value;
        return { group: group, titleGroup: titleGroup, title: title, valueText: valueText, slider: slider };
    };
    this.addOptionControl = function (parent, definition, storedId) {
        var group = parent.add("group{orientation:'column',alignChildren:['fill','top'],spacing:2,margins:0}"),
            label = group.add("statictext", undefined, cardText(definition.label || "")),
            list = group.add("dropdownlist"), options = definition.options || [], selected = -1,
            requested = String(storedId === undefined || storedId === null ? "" : storedId),
            fallback = String(definition.default === undefined || definition.default === null ? "" : definition.default);
        self.setFixedWidth(group, self.contentWidth()); self.setFixedWidth(list, self.contentWidth());
        for (var i = 0; i < options.length; i++) {
            var item = list.add("item", cardText(options[i].label || options[i].id));
            item.optionId = options[i].id;
            if (requested && String(item.optionId) == requested) selected = i;
        }
        if (selected < 0 && fallback) {
            for (var n = 0; n < options.length; n++) {
                if (String(options[n].id) == fallback) { selected = n; break; }
            }
        }
        if (selected < 0) selected = 0;
        list.selection = options.length ? selected : null;
        list.enabled = options.length > 1;
        return { control: list, getValue: function () { return list.selection ? list.selection.optionId : fallback; } };
    };
    this.addReferenceControl = function (parent, profile) {
        if (!profile.reference) profile.reference = "";
        cfg.cleanReferenceHistory();
        var group = parent.add("group{orientation:'column',alignChildren:['fill','top'],spacing:2,margins:0}"),
            label = group.add("statictext", undefined, str.imageReference),
            list = group.add("dropdownlist");
        self.setFixedWidth(group, self.contentWidth()); self.setFixedWidth(list, self.contentWidth());
        function validPath() {
            var file = profile.reference ? new File(profile.reference) : null;
            if (file && (!file.exists || !isSupportedReferenceImage(file.fsName))) profile.reference = "";
            return profile.reference || "";
        }
        function rebuild(selectedPath) {
            list.removeAll();
            var none = list.add("item", str.noneReference); none.filePath = "";
            var history = cfg.cleanReferenceHistory(), selected = 0, found = false;
            for (var i = 0; i < history.length; i++) {
                var item = list.add("item", shortenPath(history[i])); item.filePath = history[i];
                if (selectedPath && String(history[i]).toUpperCase() == String(selectedPath).toUpperCase()) { selected = i + 1; found = true; }
            }
            if (selectedPath && !found && (new File(selectedPath)).exists) {
                var current = list.add("item", shortenPath(selectedPath)); current.filePath = selectedPath; selected = list.items.length - 1;
            }
            var browse = list.add("item", str.browse); browse.browse = true;
            list.selection = Math.min(selected, list.items.length - 1);
        }
        rebuild(validPath());
        list.onChange = function () {
            if (!this.selection) return;
            if (this.selection.browse) {
                var file = (new File(" ")).openDlg(str.selectReferenceImage, REFERENCE_IMAGE_FILTER);
                if (!file) { rebuild(validPath()); return; }
                if (!isSupportedReferenceImage(file.fsName)) { self.showErrorMessage(str.errReferenceImageFormat); rebuild(validPath()); return; }
                profile.reference = file.fsName; cfg.rememberReference(file.fsName); rebuild(file.fsName); return;
            }
            profile.reference = this.selection.filePath || "";
        };
        return { control: list, getValue: function () { return profile.reference || ""; } };
    };
    this.addResizeControl = function (parent, bounds, profile, model) {
        if (profile.autoResize === undefined) profile.autoResize = cfg.autoResize;
        if (profile.manualScale === undefined) profile.manualScale = 1;
        if (profile.resize === undefined) profile.resize = 1;
        profile.resizeDirty = profile.resizeDirty === true;
        if (!profile.resizePreset) profile.resizePreset = presets.normalizeResizeName("", cfg.resizePresets);
        var multiple = model && model.input ? clamp(parseInt(model.input.dimension_multiple, 10) || 1, 1, 256) : 1,
            group = parent.add("group{orientation:'column',alignChildren:['fill','top'],spacing:0,margins:0}"),
            titleRow = group.add("group{orientation:'row',alignChildren:['left','center'],spacing:0,margins:0}"),
            checkbox = titleRow.add("checkbox"),
            title = titleRow.add("statictext"),
            valueText = titleRow.add("statictext{justify:'right'}"),
            slider = group.add("slider{minvalue:1,maxvalue:800}"),
            presetList = group.add("dropdownlist");
        self.setFixedWidth(group, self.contentWidth()); self.setFixedWidth(titleRow, self.contentWidth()); self.setFixedWidth(slider, self.contentWidth()); self.setFixedWidth(presetList, self.contentWidth());
        checkbox.preferredSize.width = self.autoResizeCheckboxWidth;
        title.preferredSize.width = self.contentWidth() - self.autoResizeCheckboxWidth - self.sliderValueWidth;
        valueText.preferredSize.width = self.sliderValueWidth;
        checkbox.value = !!profile.autoResize; checkbox.helpTip = str.autoResize;
        for (var i = 0; i < cfg.resizePresets.length; i++) presetList.add("item", presets.formatResize(cfg.resizePresets[i]));
        var presetIndex = presets.findResizeIndex(profile.resizePreset, cfg.resizePresets);
        presetList.selection = Math.max(0, presetIndex);
        profile.resizePreset = presets.findResize(profile.resizePreset, cfg.resizePresets).name;
        function sizeText() {
            var scale = profile.autoResize ? profile.resize : profile.manualScale,
                size = calculateSizeFromScale(bounds.width, bounds.height, scale, multiple),
                text = profile.autoResize ? cardText(str.autoResize) : cardText(str.resize),
                mp = Math.floor(size.width * size.height / 10000) / 100;
            return scale != 1 ? text + ": " + size.width + "x" + size.height + " (" + mp + " MP)" : text;
        }
        function setSlider() {
            if (profile.autoResize) {
                // При обычном показе интерфейса resizeDirty уже сброшен и
                // значение рассчитывается заново. После возврата из глобальных
                // настроек ручная поправка ползунка сохраняется.
                if (!profile.resizeDirty)
                    profile.resize = autoScale(bounds, presets.findResize(profile.resizePreset, cfg.resizePresets));
                slider.value = profile.resize * 100; valueText.text = profile.resize.toFixed(2);
            } else {
                slider.value = profile.manualScale * 100; profile.manualScale = Math.floor(slider.value) / 100; valueText.text = profile.manualScale.toFixed(2);
            }
            title.text = sizeText(); presetList.enabled = profile.autoResize;
        }
        function sync() {
            var v = Math.floor(slider.value), scale = (v >= 97 && v <= 103) ? 1 : Math.max(0.01, v / 100);
            if (profile.autoResize) {
                profile.resize = scale;
                profile.resizeDirty = true;
                isDirty = true;
            } else {
                profile.manualScale = scale;
                profile.resizeDirty = false;
                isDirty = false;
            }
            valueText.text = (profile.autoResize ? profile.resize : profile.manualScale).toFixed(2); title.text = sizeText();
        }
        slider.onChanging = slider.onChange = sync;
        checkbox.onClick = function () {
            profile.autoResize = this.value;
            if (profile.autoResize) profile.resizeDirty = false;
            isDirty = false;
            setSlider();
        };
        presetList.onChange = function () {
            if (!this.selection) return;
            profile.resizePreset = cfg.resizePresets[this.selection.index].name;
            profile.resizeDirty = false;
            isDirty = false;
            setSlider();
        };
        setSlider();
        return group;
    };
    this.runWithPaletteProgress = function (title, fn) {
        var progress = new StartupProgress(title || str.progressInitializing, TRANSLATE_TIMEOUT);
        try { progress.show(); progress.setStage(title || str.progressInitializing, 10); var res = fn(progress); progress.complete(); return res; }
        finally { progress.close(); }
    };
    function StartupProgress(msg, timeout) {
        var w = new Window("palette", APP.name), text = w.add("statictext"), bar = w.add("progressbar", undefined, 0, 100),
            currentMessage = msg, baseValue = 2, started = (new Date()).getTime(), stageStarted = started,
            totalTimeout = Math.max(1000, timeout || START_TIMEOUT);
        w.orientation = "column"; w.alignChildren = ["fill", "top"]; w.spacing = 5; w.margins = 15;
        text.preferredSize = [420, -1]; bar.preferredSize = [420, 15]; text.text = currentMessage; bar.value = baseValue;
        this.show = function () { w.center(); w.show(); w.update(); };
        this.setStage = function (newMessage, value) { currentMessage = newMessage || currentMessage; baseValue = Math.max(baseValue, Math.min(96, value || baseValue)); stageStarted = (new Date()).getTime(); bar.value = baseValue; text.text = currentMessage; w.update(); };
        this.pulse = function () { var elapsed = (new Date()).getTime() - stageStarted; bar.value = Math.min(97, baseValue + Math.min(12, elapsed / totalTimeout * 70)); text.text = cardText(currentMessage) + "  " + roundTo(elapsed / 1000, 1) + " " + cardText(str.secondsShort); w.update(); };
        this.complete = function () { bar.value = 100; text.text = str.progressReady; w.update(); };
        this.close = function () { try { w.close(); } catch (_) { } };
    }
    this.createStartupProgress = function (msg, timeout) { return new StartupProgress(msg, timeout); };
}

function shortenPath(path) {
    var text = String(path || ""), separator = text.indexOf("\\") >= 0 ? "\\" : "/", parts = text.split(separator);
    if (parts.length <= 3) return text;
    return parts[0] + separator + "..." + separator + parts[parts.length - 1];
}
function isSupportedReferenceImage(path) { return /\.(jpe?g|png|webp)$/i.test(String(path || "")); }



function GenerationRuntime() {
    var self = this, placementResultFile = null, placementSelection = null;
    this.run = function (selection, provider, model, profile) {
        var requestId = createRequestId(), inputFile = null, resultFile = null;
        try {
            fitSelectionBounds(selection, 1);
            var targetSize = getProfileTargetSize(selection.bounds, profile, model),
                width = targetSize.width, height = targetSize.height;
            app.activeDocument.suspendHistory(localize(str.historyPrepareSelection), "prepareSelectionLayer(selection)");
            inputFile = exportSelectionFile(selection, width, height, requestId);
            var command = {
                protocol: API_PROTOCOL,
                request_id: requestId,
                type: "api_generate",
                message: {
                    provider_id: provider.id,
                    model_id: model.id,
                    prompt: profile.prompt || "",
                    input: inputFile.fsName,
                    reference: profile.reference || "",
                    input_width: width,
                    input_height: height,
                    aspect_ratio_id: profile.aspectRatio || "",
                    quality_id: profile.quality || "",
                    credential: providerCredential(provider.id),
                    timeout: cfg.generationTimeout
                }
            },
                modelLabel = cardText(model.label || model.id),
                titles = {
                    window: cardText(str.generationProgressTitle),
                    prepare: cardText(str.progressPrepare) + " " + modelLabel + "… ",
                    generate: cardText(str.progressGenerate) + " " + modelLabel + "… "
                },
                timingKey = String(provider.id) + ":" + String(model.id);
            generationProgress.begin({ command: command, titles: titles, timingKey: timingKey, timingMax: generationTimings.getDelay(timingKey), requestId: requestId });
            app.doProgress(titles.window, "runGenerationProgress()");
            var progressResult = generationProgress.getResult();
            if (progressResult === false || (progressResult && progressResult.type == "cancelled")) {
                $.setenv(APP.dialogEnvKey, "true"); throw new Error(APP.cancelToken);
            }
            if (!progressResult) throw new Error(cardText(str.errNoResult));
            if (progressResult.type == "error") throw new Error(progressResult.message);
            var answer = progressResult.message, resultPath = typeof answer == "object" ? answer.path : answer;
            resultFile = new File(resultPath);
            if (!resultFile.exists) throw new Error(cardText(str.errResultFile) + "\n" + resultPath);
            layerMetadata.set({
                schema_version: 1,
                provider_id: provider.id,
                model_id: model.id,
                prompt: profile.prompt || "",
                profile: {
                    autoResize: profile.autoResize,
                    resizePreset: profile.resizePreset,
                    resize: profile.resize,
                    manualScale: profile.manualScale,
                    aspectRatio: profile.aspectRatio,
                    quality: profile.quality,
                    reference: profile.reference || ""
                },
                input: { width: width, height: height },
                output: {
                    actual_width: typeof answer == "object" ? answer.actual_width || 0 : 0,
                    actual_height: typeof answer == "object" ? answer.actual_height || 0 : 0
                },
                remote_request_id: typeof answer == "object" ? answer.remote_request_id || "" : ""
            });
            placementResultFile = resultFile; placementSelection = selection;
            try {
                app.activeDocument.suspendHistory(localize(str.historyPlaceResult), "placeResultHistory()");
                generationResultPlaced = true;
            } finally { placementResultFile = null; placementSelection = null; }
            try { action.saveAfterGeneration(); }
            catch (saveError) {
                $.setenv(APP.dialogEnvKey, "true");
                ui.showErrorMessage(APP.name + "\n\n" + cardText(str.errSettingsSaveAfterGeneration) + "\n" + errorMessageText(saveError));
            }
            if (typeof answer == "object" && answer.warnings instanceof Array && answer.warnings.length)
                ui.showWarningMessage(cardText(str.generationWarnings) + "\n\n• " + answer.warnings.join("\n• "));
        } finally {
            if (inputFile && inputFile.exists) try { inputFile.remove(); } catch (_) { }
            if (resultFile && resultFile.exists) try { resultFile.remove(); } catch (_) { }
            generationProgress.clear();
        }
    };
    function getProfileTargetSize(bounds, profile, model) {
        var scale = profile.autoResize
                ? ((profile.resizeDirty || isDirty)
                    ? profile.resize
                    : autoScale(bounds, presets.findResize(profile.resizePreset, cfg.resizePresets)))
                : profile.manualScale,
            multiple = model && model.input ? clamp(parseInt(model.input.dimension_multiple, 10) || 1, 1, 256) : 1;
        return calculateSizeFromScale(bounds.width, bounds.height, scale || 1, multiple);
    }
    this.prepareSelectionLayer = function (selection) {
        if (selection.previousGeneration) doc.hideSelectedLayers();
        if (doc.getProperty("quickMask")) doc.quickMask("clearEvent");
        if (doc.hasProperty("selection")) {
            doc.makeLayer(APP.generatedLayerName); doc.makeSelectionMask();
        } else if (isGeneratedLayerName(lr.getProperty("name"))) {
            if (lr.getProperty("hasUserMask")) { lr.selectChannel("mask"); doc.makeSelectionFromLayer("targetEnum"); }
            else { doc.makeSelectionFromLayer("transparencyEnum"); doc.makeSelectionMask(); }
        }
        selection.junk = lr.getProperty("layerID"); selection.flattenedSource = null;
        doc.makeSelection(selection.bounds);
        if (cfg.flatten) {
            doc.hideSelectedLayers(); doc.makeLayer(APP.generatedLayerName); doc.mergeVisible();
            selection.flattenedSource = lr.getProperty("layerID"); doc.selectLayersByIDs([selection.junk]);
        }
    };
    function exportSelectionFile(selection, width, height, requestId) {
        var hst = activeDocument.activeHistoryState,
            hiddenLayerIds = [],
            c = null;
        try { c = doc.getProperty("center").value; } catch (_) { }
        var folder = new Folder(Folder.temp.fsName + "/" + APP.tempFolder);
        if (!folder.exists) folder.create();
        var inputFile = new File(folder.fsName + "/API_IMG2IMG_" + requestId + ".jpg");
        try {
            if (cfg.flatten) {
                if (!selection.flattenedSource) throw new Error(cardText(str.errFlattenedSourceMissing));
                doc.selectLayersByIDs([selection.flattenedSource]);
            } else {
                hiddenLayerIds = hideLayersAboveSource(selection.junk);
            }
            doc.makeSelection(selection.bounds); doc.crop(true); doc.flatten(); resizeDocument(width, height); doc.saveACopy(inputFile);
        } finally {
            activeDocument.activeHistoryState = hst;

            // Photoshop не всегда полностью возвращает индивидуальные флаги
            // видимости после Hide + Crop + Flatten. Поэтому показываем только
            // верхнеуровневые слои и целые группы, которые скрипт сам скрыл и
            // которые до экспорта были видимы. Вложенная видимость групп при
            // этом не изменяется.
            if (hiddenLayerIds.length) {
                try {
                    doc.selectLayersByIDs(hiddenLayerIds);
                    doc.showSelectedLayers();
                    doc.selectLayersByIDs([selection.junk]);
                } catch (_) { }
            }
            if (c) try { doc.setProperty("center", c); } catch (_) { }
        }
        if (!inputFile.exists) throw new Error(cardText(str.errSaveJpeg));
        return inputFile;
        function resizeDocument(targetWidth, targetHeight) {
            var resolution = Number(doc.getProperty("resolution")) || 72,
                currentWidth = Math.round(Number(doc.getProperty("width")) * resolution / 72),
                currentHeight = Math.round(Number(doc.getProperty("height")) * resolution / 72);
            if (currentWidth != targetWidth || currentHeight != targetHeight) doc.imageSize(targetWidth, targetHeight);
        }
        function hideLayersAboveSource(layerId) {
            var length = doc.getProperty("numberOfLayers"),
                from = lr.getProperty("itemIndex", false, layerId) +
                    (doc.getProperty("hasBackgroundLayer") ? 0 : 1),
                ids = [],
                groupDepth = 0;

            // Индексы перебираются снизу вверх. Для самостоятельной группы
            // сначала встречается layerSectionEnd, затем её содержимое и после
            // него layerSectionStart. Пока groupDepth > 0, вложенные элементы
            // пропускаются; в список добавляется только ID самой внешней группы.
            // layerSectionStart при depth == 0 относится к родительской группе
            // исходного слоя — скрывать её нельзя.
            for (var i = from; i <= length; i++) {
                var section = lr.getProperty("layerSection", false, i, true),
                    sectionValue = section ? section.value : "";

                if (sectionValue == "layerSectionEnd") {
                    groupDepth++;
                    continue;
                }
                if (sectionValue == "layerSectionStart") {
                    if (groupDepth > 0) {
                        groupDepth--;
                        if (groupDepth == 0) addVisibleLayer(i);
                    }
                    continue;
                }
                if (sectionValue == "layerSectionContent" && groupDepth == 0)
                    addVisibleLayer(i);
            }
            if (from <= length && ids.length) {
                doc.selectLayersByIDs(ids);
                doc.hideSelectedLayers();
            }
            return ids;

            function addVisibleLayer(index) {
                var id = lr.getProperty("layerID", false, index, true),
                    visible = true,
                    duplicate = false;
                try { visible = !!lr.getProperty("visible", false, id); }
                catch (_) { }
                if (!visible) return;
                for (var n = 0; n < ids.length; n++) {
                    if (ids[n] == id) { duplicate = true; break; }
                }
                if (!duplicate) ids.push(id);
            }
        }
    }
    function generatedImageToLayer(resultFile, selection) {
        doc.place(resultFile);
        var placed = doc.descToObject(lr.getProperty("bounds").value), target = selection.bounds,
            placedWidth = placed.right - placed.left, placedHeight = placed.bottom - placed.top;
        if (!placedWidth || !placedHeight) throw new Error(cardText(str.errPlacedBounds));
        var scaleX = (target.right - target.left) / placedWidth,
            scaleY = (target.bottom - target.top) / placedHeight;
        if (cfg.keepAspectRatioDuringPlace) {
            var proportionalScale = Math.min(scaleX, scaleY); lr.transform(proportionalScale * 100, proportionalScale * 100);
        } else lr.transform(scaleX * 100, scaleY * 100);
        if (cfg.rasterizeImage) try { lr.rasterize(); } catch (_) { }
        lr.setName(APP.generatedLayerName);
        if (cfg.writeLayerMetadata) layerMetadata.write();
        var resultLayerId = lr.getProperty("layerID");
        try { doc.makeSelectionFromLayer("mask", selection.junk); }
        catch (_) { doc.makeSelection(target); }
        if (!doc.hasProperty("selection")) doc.makeSelection(target);
        doc.selectLayersByIDs([resultLayerId]); doc.makeSelectionMask(); doc.deleteLayer(selection.junk); lr.selectChannel("mask");
        if (cfg.selectBrush) try { doc.resetSwatches(); doc.selectBrush(); doc.setBrushOpacity(cfg.brushOpacity); } catch (_) { }
    }
    function isGeneratedLayerName(name) { return String(name) == APP.generatedLayerName; }
    this.checkSelection = function (res) {
        if (!apl.getProperty("numberOfDocuments")) return;
        if (doc.getProperty("quickMask")) doc.quickMask("clearEvent");
        if (doc.hasProperty("selection")) {
            res.result = true; res.bounds = doc.descToObject(doc.getProperty("selection").value); fitSelectionBounds(res, 1); return;
        }
        if (isGeneratedLayerName(lr.getProperty("name"))) {
            doc.makeSelectionFromLayer("transparencyEnum");
            if (doc.hasProperty("selection")) { res.result = true; res.bounds = doc.descToObject(doc.getProperty("selection").value); res.previousGeneration = lr.getProperty("layerID"); }
            doc.deselect(); if (res.result) fitSelectionBounds(res, 1);
        }
    };
    this.placeResultHistory = function () {
        if (!placementResultFile || !placementSelection) throw new Error(cardText(str.errNoResult));
        generatedImageToLayer(placementResultFile, placementSelection);
    };
}

function GenerationProgress() {
    var payload = null, res = null, firstAnswer = null, prepareTitle = "", generateTitle = "", delayKey = "", delayMax = 7500, requestId = null;
    this.begin = function (options) {
        options = options || {}; payload = options.command || null; res = null; firstAnswer = null;
        prepareTitle = options.titles && options.titles.prepare ? options.titles.prepare : "";
        generateTitle = options.titles && options.titles.generate ? options.titles.generate : "";
        delayKey = options.timingKey || ""; delayMax = options.timingMax || 7500; requestId = options.requestId || (payload ? payload.request_id : null);
    };
    this.run = function () {
        if (!app.doProgressSegmentTask(GENERATION_PREPARE_SEGMENT, 0, 100, "generationStageOne()")) {
            $.setenv(APP.dialogEnvKey, "true"); api.interrupt(requestId); throw new Error(APP.cancelToken);
        }
        if (!firstAnswer || firstAnswer.type == "error" || firstAnswer.message != "init") { res = firstAnswer; return true; }
        if (!app.doProgressSegmentTask(GENERATION_RUN_SEGMENT, GENERATION_PREPARE_SEGMENT, 100, "generationStageTwo()")) {
            $.setenv(APP.dialogEnvKey, "true"); api.interrupt(requestId); throw new Error(APP.cancelToken);
        }
        return true;
    };
    this.stageOne = function () {
        var answer = api.startGeneration({ command: payload, timeout: 120000, title: prepareTitle || str.progressPrepare });
        if (answer === false) return false; firstAnswer = answer; return true;
    };
    this.stageTwo = function () {
        var answer = api.finishGeneration({ timeout: cfg.generationTimeout * 1000, title: generateTitle || str.progressGenerate, max: delayMax, delayKey: delayKey, requestId: requestId });
        res = answer === false ? false : answer; return answer !== false;
    };
    this.getResult = function () { return res; };
    this.getRequestId = function () { return requestId; };
    this.clear = function () { payload = null; res = null; firstAnswer = null; prepareTitle = ""; generateTitle = ""; delayKey = ""; delayMax = 7500; requestId = null; };
}
function prepareSelectionLayer(selection) { return generation.prepareSelectionLayer(selection); }
function checkSelection(res) { return generation.checkSelection(res); }
function placeResultHistory() { return generation.placeResultHistory(); }
function runGenerationProgress() { return generationProgress.run(); }
function generationStageOne() { return generationProgress.stageOne(); }
function generationStageTwo() { return generationProgress.stageTwo(); }
function fitSelectionBounds(res, multiple) {
    multiple = clamp(parseInt(multiple, 10) || 1, 1, 256);
    if (!res.sourceBounds) res.sourceBounds = cloneObj(res.bounds);
    var source = res.sourceBounds, b = res.bounds, resolution = doc.getProperty("resolution"),
        canvas = { top: 0, left: 0, right: Math.round(doc.getProperty("width") * resolution / 72), bottom: Math.round(doc.getProperty("height") * resolution / 72) };
    b.top = Math.max(canvas.top, Math.round(source.top)); b.left = Math.max(canvas.left, Math.round(source.left));
    b.right = Math.min(canvas.right, Math.round(source.right)); b.bottom = Math.min(canvas.bottom, Math.round(source.bottom));
    if (b.right <= b.left || b.bottom <= b.top) throw new Error(cardText(str.errSelectionEmpty));
    if (b.right - b.left < multiple || b.bottom - b.top < multiple) throw new Error(cardText(str.errSelectionTooSmall) + " " + multiple + " px.");
    fitAxis("left", "right", canvas.right); fitAxis("top", "bottom", canvas.bottom);
    b.width = b.right - b.left; b.height = b.bottom - b.top;
    function fitAxis(startKey, endKey, limit) {
        var start = b[startKey], end = b[endKey], size = end - start, target = Math.floor(size / multiple) * multiple;
        if (target >= size) { start = Math.round((start + end - target) / 2); start = Math.max(0, Math.min(start, limit - target)); }
        else start += Math.floor((size - target) / 2);
        b[startKey] = start; b[endKey] = start + target;
    }
}

function LayerMetadata() {
    var cur = null;
    function ensureLibrary() {
        try {
            if (ExternalObject.AdobeXMPScript == undefined) ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
            XMPMeta.registerNamespace(APP.xmp.namespace, APP.xmp.prefix); return true;
        } catch (_) { return false; }
    }
    this.set = function (value) { cur = cloneObj(value); };
    this.write = function () {
        if (!ensureLibrary() || !cur) return false;
        try {
            var xmp; try { xmp = new XMPMeta(app.activeDocument.activeLayer.xmpMetadata.rawData); } catch (_) { xmp = new XMPMeta(); }
            xmp.setProperty(APP.xmp.namespace, APP.xmp.property, jsonStringify(cur));
            app.activeDocument.activeLayer.xmpMetadata.rawData = xmp.serialize(); return true;
        } catch (_) { return false; }
    };
    this.read = function () {
        if (!ensureLibrary() || !app.documents.length) return null;
        try {
            var xmp = new XMPMeta(app.activeDocument.activeLayer.xmpMetadata.rawData);
            if (!xmp.doesPropertyExist(APP.xmp.namespace, APP.xmp.property)) return null;
            var value = jsonParse(xmp.getProperty(APP.xmp.namespace, APP.xmp.property).value.toString());
            return isObjectMap(value) && value.provider_id && value.model_id ? value : null;
        } catch (_) { return null; }
    };
}


function BridgeApi() {
    var self = this;
    this.isRunning = function () { return checkConnection(API_HOST, API_PORT_SEND); };
    this.initialize = function (progress) {
        var pythonFile = findPythonModule();
        if (!pythonFile) throw new Error(cardText(str.errPythonMissingA) + API_FILE + cardText(str.errPythonMissingB));
        if (self.isRunning()) {
            var running = self.ping(progress);
            if (String(running.protocol) != String(API_PROTOCOL)) throw new Error(cardText(str.errApiProtocolA) + running.protocol + cardText(str.errApiProtocolB) + API_PROTOCOL + ".");
            return true;
        }
        if (progress) progress.setStage(str.progressStartPython, 3);
        pythonFile.execute();
        if (!waitForConnection(START_TIMEOUT, progress)) throw new Error(cardText(str.errPythonStartA) + API_HOST + ":" + API_PORT_SEND + cardText(str.errPythonStartB));
        var started = self.ping(progress);
        if (String(started.protocol) != String(API_PROTOCOL)) throw new Error(cardText(str.errApiProtocolA) + started.protocol + cardText(str.errApiProtocolB) + API_PROTOCOL + ".");
        return true;
    };
    this.ping = function (progress, timeout) { return call("ping", null, timeout || SHORT_TIMEOUT, progress); };
    this.translate = function (text, progress) { return call("translate", { text: text || "" }, TRANSLATE_TIMEOUT, progress); };
    this.handshake = function (progress) { return call("handshake", { generationTimeout: cfg.generationTimeout }, SHORT_TIMEOUT, progress); };
    this.encryptCredential = function (providerId, secret) { return call("credential_encrypt", { provider_id: providerId, secret: secret || "" }, SHORT_TIMEOUT); };
    this.interrupt = function (requestId) {
        try { fire(makeCommand("interrupt", { request_id: requestId || "" }, requestId)); } catch (_) { }
    };
    this.startGeneration = function (options) {
        options = options || {};
        return requestWithOptions(options.command, {
            timeout: options.timeout,
            title: options.title,
            max: options.timeout,
            interruptOnTimeout: true
        });
    };
    this.finishGeneration = function (options) {
        options = options || {};
        return waitForAnswerAfterAck({
            timeout: options.timeout,
            title: options.title,
            max: options.max,
            trackDelay: true,
            delayKey: options.delayKey,
            requestId: options.requestId,
            interruptOnTimeout: true
        });
    };
    function call(type, msg, timeout, progress) {
        return unwrapAnswer(request(makeCommand(type, msg), timeout, progress));
    }
    function request(command, timeout, progress) {
        return requestWithOptions(command, { timeout: timeout, progress: progress });
    }
    function requestWithOptions(command, options) {
        options = options || {};
        var listener = new Socket();
        if (!listener.listen(API_PORT_LISTEN, "UTF-8")) throw new Error(cardText(str.errListenerPort) + API_PORT_LISTEN + ".");
        try {
            sendCommand(command);
            options.expectedRequestId = command.request_id;
            return pollListener(listener, options);
        } finally {
            try { listener.close(); } catch (_) { }
        }
    }
    function waitForAnswerAfterAck(options) {
        options = options || {};
        var listener = new Socket();
        if (!listener.listen(API_PORT_LISTEN, "UTF-8")) throw new Error(cardText(str.errListenerPort) + API_PORT_LISTEN + ".");
        try {
            fire(makeCommand("ack", {}, options.requestId));
            options.expectedRequestId = options.requestId;
            return pollListener(listener, options);
        } finally { try { listener.close(); } catch (_) { } }
    }
    function fire(command) { sendCommand(command); }
    function sendCommand(command) {
        var sender = new Socket();
        if (!sender.open(API_HOST + ":" + API_PORT_SEND, "UTF-8")) throw new Error(cardText(str.errApiConnection));
        try { sender.writeln(jsonStringify(command)); }
        finally { sender.close(); }
    }
    function pollListener(listener, options) {
        options = options || {};
        var timeout = options.timeout || SHORT_TIMEOUT,
            title = options.title,
            progress = options.progress,
            max = options.max,
            trackDelay = !!options.trackDelay,
            delayKey = options.delayKey,
            expectedRequestId = options.expectedRequestId,
            interruptOnTimeout = !!options.interruptOnTimeout,
            t1 = (new Date()).getTime(),
            t2 = t1,
            t3 = t1,
            slice = 0;
        if (title) {
            max = Number(max) || timeout || 7500;
            if (max < 1) max = 1;
            slice = 1 / max * PROGRESS_TASK_RANGE;
        }
        for (; ;) {
            t2 = (new Date()).getTime();
            if (t2 - t1 > timeout) {
                if (interruptOnTimeout && expectedRequestId) {
                    try { self.interrupt(expectedRequestId); } catch (_) { }
                }
                listener.close();
                throw new Error(cardText(str.errApiTimeout));
            }
            if (progress) progress.pulse();
            if (title && t2 - t3 >= 1) {
                t3 = t2;
                var text = trackDelay
                    ? title + "\t " + Math.floor((t2 - t1) / 100) / 10 + " s. "
                    : title;
                if (!app.doProgressTask(slice, "workChunk('" + escapeProgressText(text) + "');")) {
                    $.setenv(APP.dialogEnvKey, "true");
                    try { self.interrupt(expectedRequestId); } catch (_) { }
                    listener.close();
                    return false;
                }
            }
            var connection = listener.poll();
            if (connection != null) {
                var answer = null,
                    rawAnswer = "";
                try {
                    rawAnswer = connection.readln();
                    answer = jsonParse(rawAnswer);
                } catch (parseError) {
                    connection.close();
                    listener.close();
                    throw new Error(cardText(str.errApiInvalidAnswer) + " " + parseError.message +
                        " (" + rawAnswer.length + " chars)");
                }
                connection.close();
                if (!answer) {
                    listener.close();
                    throw new Error(cardText(str.errEmptyApiAnswer));
                }
                if (expectedRequestId && String(answer.request_id || "") != String(expectedRequestId)) continue;
                listener.close();
                if (trackDelay && delayKey) {
                    try { generationTimings.saveDelay(delayKey, t2 - t1); } catch (_) { }
                }
                return answer;
            }
            $.sleep(1);
        }
    }
    function workChunk(text) {
        app.changeProgressText(text);
        $.sleep(0);
    }
    function escapeProgressText(text) {
        return String(text)
            .replace(/\\/g, "\\\\")
            .replace(/'/g, "\\'")
            .replace(/[\r\n]+/g, " ");
    }
    function findPythonModule() {
        var base = (new File($.fileName)).parent,
            candidates = [
                // Рекомендуемая структура релиза: Python API и cards находятся
                // в lib. Этот путь проверяется первым, чтобы старая копия API,
                // случайно оставшаяся рядом с JSX, не получила приоритет.
                new File(base.fsName + "/lib/" + API_FILE + ".pyw"),
                new File(base.fsName + "/lib/" + API_FILE + ".py"),
                // Плоская структура также поддерживается.
                new File(base.fsName + "/" + API_FILE + ".pyw"),
                new File(base.fsName + "/" + API_FILE + ".py")
            ];
        for (var i = 0; i < candidates.length; i++) if (candidates[i].exists) return candidates[i];
        return null;
    }
    function waitForConnection(timeout, startup) {
        var started = (new Date()).getTime();
        while ((new Date()).getTime() - started < timeout) {
            if (checkConnection(API_HOST, API_PORT_SEND)) return true;
            if (startup) startup.pulse();
            $.sleep(25);
        }
        return false;
    }
    function checkConnection(host, port) {
        var socket = new Socket();
        try { return socket.open(host + ":" + port, "UTF-8"); }
        catch (_) { return false; }
        finally { try { socket.close(); } catch (_) { } }
    }
    function makeCommand(type, msg, requestId) {
        return { protocol: API_PROTOCOL, request_id: requestId || createRequestId(), type: type, message: msg || {} };
    }
    function unwrapAnswer(response) {
        if (!response) throw new Error(cardText(str.errEmptyApiAnswer));
        if (response.type == "error") throw new Error(response.message);
        return response.message;
    }
}
// ============================================================================
// СЕРИАЛИЗАЦИЯ ОБЪЕКТОВ В ActionDescriptor
// Используется и для DESC, и для playbackParameters. Null/function пропускаются;
// вложенные объекты и массивы рекурсивно превращаются в Descriptor/List.
// ============================================================================

function DescriptorCodec() {
    function readDescriptor(target, desc) {
        for (var i = 0; i < desc.count; i++) {
            var key = desc.getKey(i),
                name = t2s(key),
                type = desc.getType(key);
            if (type == DescValueType.BOOLEANTYPE) target[name] = desc.getBoolean(key);
            else if (type == DescValueType.STRINGTYPE) target[name] = desc.getString(key);
            else if (type == DescValueType.INTEGERTYPE) target[name] = desc.getInteger(key);
            else if (type == DescValueType.LARGEINTEGERTYPE) target[name] = desc.getLargeInteger(key);
            else if (type == DescValueType.DOUBLETYPE) target[name] = desc.getDouble(key);
            else if (type == DescValueType.OBJECTTYPE) {
                target[name] = {};
                readDescriptor(target[name], desc.getObjectValue(key));
            } else if (type == DescValueType.LISTTYPE) target[name] = readList(desc.getList(key));
        }
        return target;
    }
    function readList(list) {
        var res = [];
        for (var i = 0; i < list.count; i++) {
            var type = list.getType(i);
            if (type == DescValueType.BOOLEANTYPE) res.push(list.getBoolean(i));
            else if (type == DescValueType.STRINGTYPE) res.push(list.getString(i));
            else if (type == DescValueType.INTEGERTYPE) res.push(list.getInteger(i));
            else if (type == DescValueType.LARGEINTEGERTYPE) res.push(list.getLargeInteger(i));
            else if (type == DescValueType.DOUBLETYPE) res.push(list.getDouble(i));
            else if (type == DescValueType.OBJECTTYPE) res.push(readDescriptor({}, list.getObjectValue(i)));
            else if (type == DescValueType.LISTTYPE) res.push(readList(list.getList(i)));
        }
        return res;
    }
    function writeDescriptor(object, integerNumbers) {
        var desc = new ActionDescriptor();
        for (var name in object) if (object.hasOwnProperty(name)) {
            var value = object[name];
            if (value === null || value === undefined || typeof value == "function") continue;
            var key;
            try { key = s2t(String(name)); } catch (_) { continue; }
            if (typeof value == "boolean") desc.putBoolean(key, value);
            else if (typeof value == "string") desc.putString(key, value);
            else if (typeof value == "number") {
                if (integerNumbers && value == Math.round(value) && value >= -2147483648 && value <= 2147483647)
                    desc.putInteger(key, value);
                else desc.putDouble(key, value);
            } else if (value instanceof Array) desc.putList(key, writeList(value, integerNumbers));
            else if (typeof value == "object") desc.putObject(key, s2t("object"), writeDescriptor(value, integerNumbers));
        }
        return desc;
    }
    function writeList(array, integerNumbers) {
        var list = new ActionList();
        for (var i = 0; i < array.length; i++) {
            var value = array[i];
            if (value === null || value === undefined || typeof value == "function") continue;
            if (typeof value == "boolean") list.putBoolean(value);
            else if (typeof value == "string") list.putString(value);
            else if (typeof value == "number") {
                if (integerNumbers && value == Math.round(value) && value >= -2147483648 && value <= 2147483647)
                    list.putInteger(value);
                else list.putDouble(value);
            } else if (value instanceof Array) list.putList(writeList(value, integerNumbers));
            else if (typeof value == "object") list.putObject(s2t("object"), writeDescriptor(value, integerNumbers));
        }
        return list;
    }
    this.readInto = function (target, desc) { return readDescriptor(target || {}, desc); };
    this.toDescriptor = function (object, integerNumbers) { return writeDescriptor(object || {}, !!integerNumbers); };
}
// ============================================================================
// КОНФИГУРАЦИЯ, ПРОФИЛИ И ХРАНИЛИЩА
// self.data — сериализуемый объект; bindProperties создаёт удобные ссылки
// self.foo. Перед записью syncData возвращает изменённые ссылки обратно в data.
// ============================================================================


function Config() {
    var self = this, loadWarnings = [], recoveredFromBackup = false,
        keys = ["selectedProvider", "selectedModel", "modelProfiles", "autoResize", "resizePresets", "flatten", "rasterizeImage", "keepAspectRatioDuringPlace", "recordSettingsToAction", "writeLayerMetadata", "selectBrush", "brushOpacity", "generationTimeout", "providerCredentials", "referenceHistory", "promptPresets"];
    this.data = defaultData();
    this.bindProperties = function () { for (var i = 0; i < keys.length; i++) this[keys[i]] = this.data[keys[i]]; };
    function syncData() { for (var i = 0; i < keys.length; i++) self.data[keys[i]] = self[keys[i]]; }
    function copyCurrentFields(loaded) {
        var data = defaultData();
        if (!isObjectMap(loaded)) return data;
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (loaded.hasOwnProperty(key)) data[key] = cloneObj(loaded[key]);
        }
        return data;
    }
    function isCurrentSettingsData(loaded) {
        return isObjectMap(loaded) && Number(loaded.settingsDataVersion) == SETTINGS_DATA_VERSION;
    }
    function applyLoadedData(loaded) {
        self.data = loaded ? copyCurrentFields(loaded) : defaultData();
        self.bindProperties();
        if (!self.resizePresets || !self.resizePresets.length) self.resizePresets = self.data.resizePresets = presets.defaultResize();
        if (!isObjectMap(self.modelProfiles)) self.modelProfiles = self.data.modelProfiles = {};
        if (!isObjectMap(self.providerCredentials)) self.providerCredentials = self.data.providerCredentials = {};
        if (!isObjectMap(self.promptPresets)) self.promptPresets = self.data.promptPresets = presets.defaultPrompt();
        self.cleanReferenceHistory();
    }
    function controlOptionId(model, controlName, fallback) {
        var control = model && model.controls ? model.controls[controlName] : null,
            value = control && control.default !== undefined && control.default !== null ? String(control.default) : String(fallback || "");
        return value;
    }
    function controlHasOption(model, controlName, value) {
        var control = model && model.controls ? model.controls[controlName] : null,
            options = control && control.options instanceof Array ? control.options : [];
        for (var i = 0; i < options.length; i++) if (String(options[i].id) == String(value)) return true;
        return false;
    }
    this.getModelProfile = function (modelId, model) {
        if (!isObjectMap(self.modelProfiles)) self.modelProfiles = self.data.modelProfiles = {};
        var key = settingsKey(modelId), profile = self.modelProfiles[key],
            defaultAspect = controlOptionId(model, "aspect_ratio", "selection"),
            defaultQuality = controlOptionId(model, "quality", "");
        if (!isObjectMap(profile)) profile = self.modelProfiles[key] = {
            prompt: "",
            autoResize: self.autoResize,
            resizePreset: presets.normalizeResizeName("", self.resizePresets),
            resize: 1,
            resizeDirty: false,
            manualScale: 1,
            aspectRatio: defaultAspect,
            quality: defaultQuality,
            reference: ""
        };
        profile.prompt = profile.prompt === undefined || profile.prompt === null ? "" : String(profile.prompt);
        if (profile.autoResize === undefined) profile.autoResize = self.autoResize;
        if (!profile.resizePreset) profile.resizePreset = presets.normalizeResizeName("", self.resizePresets);
        if (profile.resize === undefined) profile.resize = 1;
        profile.resizeDirty = profile.resizeDirty === true;
        if (profile.manualScale === undefined) profile.manualScale = 1;
        if (model && model.controls && model.controls.aspect_ratio && !controlHasOption(model, "aspect_ratio", profile.aspectRatio)) profile.aspectRatio = defaultAspect;
        else if (profile.aspectRatio === undefined) profile.aspectRatio = defaultAspect;
        if (model && model.controls && model.controls.quality && !controlHasOption(model, "quality", profile.quality)) profile.quality = defaultQuality;
        else if (profile.quality === undefined) profile.quality = defaultQuality;
        if (profile.reference === undefined || profile.reference === null) profile.reference = "";
        else profile.reference = String(profile.reference);
        return profile;
    };
    this.getPromptPresetStore = function (context) { return presets.promptStore(self, context); };
    this.cleanReferenceHistory = function () {
        var source = self.referenceHistory instanceof Array ? self.referenceHistory : [], cleaned = [];
        for (var i = 0; i < source.length && cleaned.length < 10; i++) {
            var file = new File(source[i]);
            if (file.exists && isSupportedReferenceImage(file.fsName) && !arrayContainsCaseInsensitive(cleaned, file.fsName)) cleaned.push(file.fsName);
        }
        self.referenceHistory = self.data.referenceHistory = cleaned; return cleaned;
    };
    this.rememberReference = function (path) {
        var file = new File(path || ""); if (!file.exists || !isSupportedReferenceImage(file.fsName)) return;
        var cur = self.cleanReferenceHistory(), res = [file.fsName];
        for (var i = 0; i < cur.length && res.length < 10; i++) if (!arrayContainsCaseInsensitive(res, cur[i])) res.push(cur[i]);
        self.referenceHistory = self.data.referenceHistory = res;
    };
    this.copyAllDataFrom = function (source) {
        applyLoadedData(source && source.data ? cloneObj(source.data) : null);
    };
    this.copyGlobalDataTo = function (target) {
        if (!target) return;
        // Эти поля являются глобальными и при любом playback принадлежат DESC.
        // selectedProvider, selectedModel и modelProfiles намеренно не копируются:
        // снимок выбранной модели из Action не должен менять обычный запуск.
        var globalKeys = [
            "autoResize", "resizePresets", "flatten", "rasterizeImage",
            "keepAspectRatioDuringPlace", "recordSettingsToAction",
            "writeLayerMetadata", "selectBrush", "brushOpacity",
            "generationTimeout", "providerCredentials", "referenceHistory",
            "promptPresets"
        ];
        for (var i = 0; i < globalKeys.length; i++) {
            var key = globalKeys[i];
            target[key] = target.data[key] = cloneObj(self[key]);
        }
        target.cleanReferenceHistory();
    };
    function modelProfileData(profile) {
        profile = isObjectMap(profile) ? profile : {};
        return {
            prompt: profile.prompt === undefined || profile.prompt === null ? "" : String(profile.prompt),
            autoResize: profile.autoResize !== false,
            resizePreset: String(profile.resizePreset || ""),
            resize: Number(profile.resize === undefined ? 1 : profile.resize),
            resizeDirty: profile.resizeDirty === true,
            manualScale: Number(profile.manualScale === undefined ? 1 : profile.manualScale),
            aspectRatio: String(profile.aspectRatio || ""),
            quality: String(profile.quality || ""),
            reference: String(profile.reference || "")
        };
    }
    function actionData(recordMode) {
        var enabled = recordMode === undefined ? !!self.recordSettingsToAction : !!recordMode,
            res = {
                actionDataVersion: ACTION_DATA_VERSION,
                recordSettingsToAction: enabled
            };
        if (!enabled) return res;
        var modelId = String(self.selectedModel || ""),
            profile = modelId ? self.getModelProfile(modelId, null) : null;
        res.selectedProvider = String(self.selectedProvider || "");
        res.selectedModel = modelId;
        res.modelProfile = modelProfileData(profile);
        return res;
    }
    function settingsFile(suffix) { return new File(app.preferencesFolder + "/" + APP.settingsFile + (suffix || "")); }
    function fileError(file) { try { return file && file.error ? String(file.error) : ""; } catch (_) { return ""; } }
    function operationError(prefix, file) { var detail = fileError(file); return cardText(prefix) + "\n" + file.fsName + (detail ? "\n" + detail : ""); }
    function readSettingsData(file) {
        var opened = false;
        try {
            file.encoding = "BINARY"; if (!file.open("r")) throw new Error(operationError(str.errSettingsReadFile, file)); opened = true;
            var stream = file.read(); if (fileError(file)) throw new Error(operationError(str.errSettingsReadFile, file));
            if (file.close() === false) throw new Error(operationError(str.errSettingsReadFile, file)); opened = false;
            var desc = new ActionDescriptor(), loaded = {}; desc.fromStream(stream); descriptorCodec.readInto(loaded, desc); return loaded;
        } finally { if (opened) try { file.close(); } catch (_) { } }
    }
    function writeSettingsStream(file, stream) {
        var opened = false;
        if (file.exists && !file.remove()) throw new Error(operationError(str.errSettingsWriteFile, file));
        try {
            file.encoding = "BINARY"; if (!file.open("w")) throw new Error(operationError(str.errSettingsWriteFile, file)); opened = true;
            var written = file.write(stream); if (written === false || fileError(file)) throw new Error(operationError(str.errSettingsWriteFile, file));
            if (file.close() === false) throw new Error(operationError(str.errSettingsWriteFile, file)); opened = false;
        } finally { if (opened) try { file.close(); } catch (_) { } }
        readSettingsData(new File(file.fsName));
    }
    function restoreBackup(primaryPath, backupPath) {
        var primary = new File(primaryPath), backup = new File(backupPath);
        if (primary.exists && !primary.remove()) return false;
        return backup.exists && backup.rename(APP.settingsFile);
    }
    this.consumeLoadWarnings = function () { var res = loadWarnings; loadWarnings = []; return res; };
    this.load = function () {
        loadWarnings = []; recoveredFromBackup = false;
        var file = settingsFile(""), backup = settingsFile(".bak"), loaded = null, primaryError = null, incompatible = false;
        if (file.exists) try {
            loaded = readSettingsData(file);
            if (!isCurrentSettingsData(loaded)) { loaded = null; incompatible = true; }
        } catch (e) { primaryError = e; }
        if (!loaded && backup.exists) try {
            var backupData = readSettingsData(backup);
            if (isCurrentSettingsData(backupData)) {
                loaded = backupData;
                recoveredFromBackup = true;
                loadWarnings.push(cardText(str.settingsBackupRecovered) + "\n" + backup.fsName +
                    (primaryError ? "\n\n" + cardText(str.settingsPrimaryReadError) + "\n" + errorMessageText(primaryError) : ""));
            } else incompatible = true;
        } catch (backupError) {
            if (primaryError) throw new Error(cardText(str.errSettingsUnreadable) + "\n\n" + errorMessageText(primaryError) + "\n\n" + errorMessageText(backupError));
            if (!incompatible) throw backupError;
        }
        if (!loaded && primaryError && !incompatible) throw new Error(cardText(str.errSettingsUnreadable) + "\n\n" + errorMessageText(primaryError));
        if (!loaded && incompatible) loadWarnings.push(cardText(str.settingsVersionReset));
        applyLoadedData(loaded);
    };
    this.loadModelFromAction = function () {
        var loaded = {};
        try { descriptorCodec.readInto(loaded, app.playbackParameters); } catch (_) { loaded = {}; }
        if (!isObjectMap(loaded) || Number(loaded.actionDataVersion) != ACTION_DATA_VERSION ||
            loaded.recordSettingsToAction !== true || !loaded.selectedProvider ||
            !loaded.selectedModel || !isObjectMap(loaded.modelProfile))
            throw new Error(cardText(str.errActionSettingsVersion));
        self.selectedProvider = self.data.selectedProvider = String(loaded.selectedProvider);
        self.selectedModel = self.data.selectedModel = String(loaded.selectedModel);
        if (!isObjectMap(self.modelProfiles)) self.modelProfiles = self.data.modelProfiles = {};
        self.modelProfiles[settingsKey(self.selectedModel)] = modelProfileData(loaded.modelProfile);
    };
    this.saveToAction = function (recordMode) {
        syncData();
        playbackParameters = descriptorCodec.toDescriptor(actionData(recordMode));
    };
    this.save = function () {
        syncData();
        var desc = descriptorCodec.toDescriptor(self.data), stream = desc.toStream(), file = settingsFile(""), temp = settingsFile(".tmp"), backup = settingsFile(".bak"),
            primaryPath = file.fsName, tempPath = temp.fsName, backupPath = backup.fsName, hadPrimary = file.exists, primaryMoved = false, promoted = false;
        writeSettingsStream(temp, stream);
        try {
            if (hadPrimary) {
                if (recoveredFromBackup && backup.exists) {
                    if (!(new File(primaryPath)).remove()) throw new Error(operationError(str.errSettingsReplaceFile, new File(primaryPath))); primaryMoved = true;
                } else {
                    if (backup.exists && !backup.remove()) throw new Error(operationError(str.errSettingsWriteFile, backup));
                    if (!(new File(primaryPath)).rename(APP.settingsFile + ".bak")) throw new Error(operationError(str.errSettingsBackupFile, new File(primaryPath))); primaryMoved = true;
                }
            }
            if (!(new File(tempPath)).rename(APP.settingsFile)) {
                if (primaryMoved && !restoreBackup(primaryPath, backupPath)) throw new Error(cardText(str.errSettingsRestoreBackup) + "\n" + backupPath);
                throw new Error(operationError(str.errSettingsReplaceFile, new File(tempPath)));
            }
            promoted = true; readSettingsData(new File(primaryPath)); recoveredFromBackup = false;
        } catch (e) {
            if (promoted) {
                if (primaryMoved) { if (!restoreBackup(primaryPath, backupPath)) throw new Error(errorMessageText(e) + "\n\n" + cardText(str.errSettingsRestoreBackup) + "\n" + backupPath); }
                else { var failedPrimary = new File(primaryPath); if (failedPrimary.exists) try { failedPrimary.remove(); } catch (_) { } }
            }
            var staleTemp = new File(tempPath); if (staleTemp.exists) try { staleTemp.remove(); } catch (_) { }
            throw e;
        }
    };
    this.bindProperties();
    function defaultData() {
        return {
            settingsDataVersion: SETTINGS_DATA_VERSION,
            selectedProvider: "neuroapi",
            selectedModel: "neuroapi:gpt-image-2",
            modelProfiles: {},
            autoResize: true,
            resizePresets: presets.defaultResize(),
            flatten: false,
            rasterizeImage: false,
            keepAspectRatioDuringPlace: false,
            recordSettingsToAction: true,
            writeLayerMetadata: false,
            selectBrush: true,
            brushOpacity: 60,
            generationTimeout: 1200,
            providerCredentials: {},
            referenceHistory: [],
            promptPresets: presets.defaultPrompt()
        };
    }
}

function ActionRuntime() {
    function saveGlobalData() {
        if (!globalSettings) return;
        cfg.copyGlobalDataTo(globalSettings); globalSettings.save();
    }
    this.getPlaybackParameterCount = function () { try { return app.playbackParameters ? app.playbackParameters.count : 0; } catch (_) { return 0; } };
    this.isPlayback = function (parameterCount) {
        try { var desc = app.playbackParameters, marker = s2t("actionDataVersion"); if (desc && desc.hasKey(marker)) return true; } catch (_) { }
        return Number(parameterCount) > 1;
    };
    this.hasInterfaceArgument = function () {
        var values = []; try { if ($.arguments && $.arguments.length) for (var i = 0; i < $.arguments.length; i++) values.push($.arguments[i]); } catch (_) { }
        for (var j = 0; j < values.length; j++) { var value = String(values[j]).toLowerCase(); if (value == "dialog" || value == "ui" || value == "--dialog" || value == "--ui" || value == "/dialog" || value == "/ui") return true; }
        return false;
    };
    this.getRecordedSettingsMode = function () {
        try { var desc = app.playbackParameters, key = s2t("recordSettingsToAction"); if (desc && desc.hasKey(key) && desc.getType(key) == DescValueType.BOOLEANTYPE) return desc.getBoolean(key); } catch (_) { }
        return true;
    };
    this.saveAcceptedSettings = function () {
        if (actionPlaybackMode) {
            if (actionUsesRecordedSettings) {
                // Обновляем только снимок выбранной модели в текущем Action.
                // Глобальные изменения (ключи, пресеты и настройки скрипта)
                // сохраняются отдельно в обычный DESC.
                cfg.saveToAction(true);
                saveGlobalData();
            } else {
                // Action без записанных параметров всегда работает с DESC.
                cfg.save();
                cfg.saveToAction(false);
            }
            return;
        }
        cfg.save();
        cfg.saveToAction();
    };
    this.saveAfterGeneration = function () {
        if (actionPlaybackMode) {
            if (actionUsesRecordedSettings) cfg.saveToAction(true);
            else { cfg.save(); cfg.saveToAction(false); }
            return;
        }
        cfg.save();
    };
    this.saveAfterError = function () {
        if (!settingsReady) return "";
        try { this.saveAcceptedSettings(); return ""; }
        catch (saveError) { return errorMessageText(saveError) + (saveError && saveError.line ? " (" + cardText(str.jsxLine) + saveError.line + ")" : ""); }
    };
}


function AM(target, order) {
    var AR = ActionReference, AD = ActionDescriptor;
    target = target ? s2t(target) : null;
    this.getProperty = function (property, descriptorMode, id, indexMode) {
        var propertyId = s2t(property), ref = new AR();
        ref.putProperty(s2t("property"), propertyId);
        if (id !== undefined && id !== null) {
            if (indexMode) ref.putIndex(target, id); else ref.putIdentifier(target, id);
        } else ref.putEnumerated(target, s2t("ordinal"), order ? s2t(order) : s2t("targetEnum"));
        var desc = executeActionGet(ref);
        return descriptorMode ? desc : getDescValue(desc, propertyId);
    };
    this.hasProperty = function (property, id, indexMode) {
        var propertyId = s2t(property), ref = new AR();
        ref.putProperty(s2t("property"), propertyId);
        if (id !== undefined && id !== null) {
            if (indexMode) ref.putIndex(target, id); else ref.putIdentifier(target, id);
        } else ref.putEnumerated(target, s2t("ordinal"), s2t("targetEnum"));
        try { return executeActionGet(ref).hasKey(propertyId); } catch (_) { return false; }
    };
    this.setProperty = function (property, value) {
        var propertyId = s2t(property), ref = new AR();
        ref.putProperty(s2t("property"), propertyId);
        ref.putEnumerated(target, s2t("ordinal"), s2t("targetEnum"));
        var desc = new AD();
        desc.putReference(s2t("null"), ref);
        desc.putObject(s2t("to"), propertyId, value);
        executeAction(s2t("set"), desc, DialogModes.NO);
    };
    this.descToObject = function (desc) {
        var res = {}, i;
        for (i = 0; i < desc.count; i++) {
            var key = desc.getKey(i);
            res[t2s(key)] = getDescValue(desc, key);
        }
        return res;
    };
    this.makeSelection = function (bounds) {
        var ref = new AR(); ref.putProperty(s2t("channel"), s2t("selection"));
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        var rectangle = new AD();
        rectangle.putUnitDouble(s2t("top"), s2t("pixelsUnit"), bounds.top);
        rectangle.putUnitDouble(s2t("left"), s2t("pixelsUnit"), bounds.left);
        rectangle.putUnitDouble(s2t("bottom"), s2t("pixelsUnit"), bounds.bottom);
        rectangle.putUnitDouble(s2t("right"), s2t("pixelsUnit"), bounds.right);
        desc.putObject(s2t("to"), s2t("rectangle"), rectangle);
        executeAction(s2t("set"), desc, DialogModes.NO);
    };
    this.makeSelectionFromLayer = function (channel, id) {
        var selectionRef = new AR(); selectionRef.putProperty(s2t("channel"), s2t("selection"));
        var desc = new AD(); desc.putReference(s2t("null"), selectionRef);
        var sourceRef = new AR(); sourceRef.putEnumerated(s2t("channel"), s2t("channel"), s2t(channel));
        if (id !== undefined && id !== null) sourceRef.putIdentifier(s2t("layer"), id);
        desc.putReference(s2t("to"), sourceRef);
        executeAction(s2t("set"), desc, DialogModes.NO);
    };
    this.deselect = function () {
        var ref = new AR(); ref.putProperty(s2t("channel"), s2t("selection"));
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        desc.putEnumerated(s2t("to"), s2t("ordinal"), s2t("none"));
        executeAction(s2t("set"), desc, DialogModes.NO);
    };
    this.quickMask = function (eventName) {
        var ref = new AR(); ref.putProperty(s2t("property"), s2t("quickMask"));
        ref.putEnumerated(s2t("document"), s2t("ordinal"), s2t("targetEnum"));
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        executeAction(s2t(eventName), desc, DialogModes.NO);
    };
    this.makeLayer = function (name) {
        var ref = new AR(); ref.putClass(s2t("layer"));
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        var layerDescriptor = new AD(); layerDescriptor.putString(s2t("name"), name);
        desc.putObject(s2t("using"), s2t("layer"), layerDescriptor);
        executeAction(s2t("make"), desc, DialogModes.NO);
    };
    this.makeSelectionMask = function () {
        var desc = new AD(); desc.putClass(s2t("new"), s2t("channel"));
        var ref = new AR(); ref.putEnumerated(s2t("channel"), s2t("channel"), s2t("mask"));
        desc.putReference(s2t("at"), ref);
        desc.putEnumerated(s2t("using"), s2t("userMask"), s2t("revealSelection"));
        executeAction(s2t("make"), desc, DialogModes.NO);
    };
    this.flatten = function () {
        executeAction(s2t("flattenImage"), undefined, DialogModes.NO);
    };
    this.mergeVisible = function () {
        executeAction(s2t("mergeVisible"), undefined, DialogModes.NO);
    };
    this.crop = function (deletePixels) {
        var desc = new AD(); desc.putBoolean(s2t("delete"), !!deletePixels);
        executeAction(s2t("crop"), desc, DialogModes.NO);
    };
    this.imageSize = function (width, height) {
        var desc = new AD();
        desc.putUnitDouble(s2t("width"), s2t("pixelsUnit"), width);
        desc.putUnitDouble(s2t("height"), s2t("pixelsUnit"), height);
        desc.putEnumerated(s2t("interpolation"), s2t("interpolationType"), s2t("automaticInterpolation"));
        executeAction(s2t("imageSize"), desc, DialogModes.NO);
    };
    this.saveAPNGCopy = function (file) {
        var pngOptions = new AD();
        pngOptions.putEnumerated(s2t("method"), s2t("PNGMethod"), s2t("quick"));
        pngOptions.putEnumerated(s2t("PNGInterlaceType"), s2t("PNGInterlaceType"), s2t("PNGInterlaceNone"));
        pngOptions.putEnumerated(s2t("PNGFilter"), s2t("PNGFilter"), s2t("PNGFilterAdaptive"));
        pngOptions.putInteger(s2t("compression"), 6);
        var desc = new AD();
        desc.putObject(s2t("as"), s2t("PNGFormat"), pngOptions);
        desc.putPath(s2t("in"), file);
        desc.putBoolean(s2t("copy"), true);
        executeAction(s2t("save"), desc, DialogModes.NO);
    };
    this.selectAllPixels = function () {
        var ref = new AR(); ref.putProperty(s2t("channel"), s2t("selection"));
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        desc.putEnumerated(s2t("to"), s2t("ordinal"), s2t("allEnum"));
        executeAction(s2t("set"), desc, DialogModes.NO);
    };
    this.copyPixels = function () {
        var desc = new AD(); desc.putString(s2t("copyHint"), "pixels");
        executeAction(s2t("copyEvent"), desc, DialogModes.NO);
    };
    this.pastePixels = function () {
        var desc = new AD();
        desc.putEnumerated(s2t("antiAlias"), s2t("antiAliasType"), s2t("antiAliasNone"));
        desc.putClass(s2t("as"), s2t("pixel"));
        executeAction(s2t("paste"), desc, DialogModes.NO);
    };
    this.invert = function () {
        executeAction(s2t("invert"), new AD(), DialogModes.NO);
    };
    this.saveACopy = function (file) {
        var jpegOptions = new AD();
        jpegOptions.putInteger(s2t("extendedQuality"), 12);
        jpegOptions.putEnumerated(s2t("matteColor"), s2t("matteColor"), s2t("none"));
        var desc = new AD();
        desc.putObject(s2t("as"), s2t("JPEG"), jpegOptions);
        desc.putPath(s2t("in"), file);
        desc.putBoolean(s2t("copy"), true);
        executeAction(s2t("save"), desc, DialogModes.NO);
    };
    this.place = function (file) {
        var desc = new AD(); desc.putPath(s2t("null"), file); desc.putBoolean(s2t("linked"), false);
        executeAction(s2t("placeEvent"), desc, DialogModes.NO);
    };
    this.transform = function (widthPercent, heightPercent, offsetX, offsetY) {
        var desc = new AD();
        desc.putEnumerated(s2t("freeTransformCenterState"), s2t("quadCenterState"), s2t("QCSAverage"));
        var offset = new AD();
        offset.putUnitDouble(s2t("horizontal"), s2t("pixelsUnit"), offsetX || 0);
        offset.putUnitDouble(s2t("vertical"), s2t("pixelsUnit"), offsetY || 0);
        desc.putObject(s2t("offset"), s2t("offset"), offset);
        desc.putUnitDouble(s2t("width"), s2t("percentUnit"), widthPercent);
        desc.putUnitDouble(s2t("height"), s2t("percentUnit"), heightPercent);
        executeAction(s2t("transform"), desc, DialogModes.NO);
    };
    this.rasterize = function () {
        var ref = new AR(); ref.putEnumerated(s2t("layer"), s2t("ordinal"), s2t("targetEnum"));
        var desc = new AD(); desc.putReference(s2t("target"), ref);
        executeAction(s2t("rasterizePlaced"), desc, DialogModes.NO);
    };
    this.selectLayersByIDs = function (ids) {
        var ref = new AR();
        for (var i = 0; i < ids.length; i++) ref.putIdentifier(s2t("layer"), ids[i]);
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        executeAction(s2t("select"), desc, DialogModes.NO);
    };
    this.hideSelectedLayers = function () {
        var ref = new AR(); ref.putEnumerated(s2t("layer"), s2t("ordinal"), s2t("targetEnum"));
        var list = new ActionList(); list.putReference(ref);
        var desc = new AD(); desc.putList(s2t("null"), list);
        executeAction(s2t("hide"), desc, DialogModes.NO);
    };
    this.showSelectedLayers = function () {
        var ref = new AR(); ref.putEnumerated(s2t("layer"), s2t("ordinal"), s2t("targetEnum"));
        var list = new ActionList(); list.putReference(ref);
        var desc = new AD(); desc.putList(s2t("null"), list);
        executeAction(s2t("show"), desc, DialogModes.NO);
    };
    this.setName = function (name) {
        var ref = new AR(); ref.putEnumerated(s2t("layer"), s2t("ordinal"), s2t("targetEnum"));
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        var layerDescriptor = new AD(); layerDescriptor.putString(s2t("name"), name);
        desc.putObject(s2t("to"), s2t("layer"), layerDescriptor);
        executeAction(s2t("set"), desc, DialogModes.NO);
    };
    this.deleteLayer = function (id) {
        var ref = new AR();
        if (id !== undefined && id !== null) ref.putIdentifier(s2t("layer"), id);
        else ref.putEnumerated(s2t("layer"), s2t("ordinal"), s2t("targetEnum"));
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        executeAction(s2t("delete"), desc, DialogModes.NO);
    };
    this.selectChannel = function (channel) {
        var ref = new AR(); ref.putEnumerated(s2t("channel"), s2t("channel"), s2t(channel));
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        executeAction(s2t("select"), desc, DialogModes.NO);
    };
    this.selectBrush = function () {
        var ref = new AR(); ref.putClass(s2t("paintbrushTool"));
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        executeAction(s2t("select"), desc, DialogModes.NO);
    };
    this.resetSwatches = function () {
        var ref = new AR(); ref.putProperty(s2t("color"), s2t("colors"));
        var desc = new AD(); desc.putReference(s2t("null"), ref);
        executeAction(s2t("reset"), desc, DialogModes.NO);
    };
    this.setBrushOpacity = function (opacity) {
        var property = s2t("currentToolOptions"),
            ref = new AR(); ref.putProperty(s2t("property"), property);
        ref.putEnumerated(s2t("application"), s2t("ordinal"), s2t("targetEnum"));
        var options = executeActionGet(ref).getObjectValue(property);
        options.putInteger(s2t("opacity"), opacity);
        var toolRef = new AR(); toolRef.putClass(s2t("paintbrushTool"));
        var desc = new AD(); desc.putReference(s2t("target"), toolRef);
        desc.putObject(s2t("to"), s2t("target"), options);
        executeAction(s2t("set"), desc, DialogModes.NO);
    };
    function getDescValue(desc, key) {
        switch (desc.getType(key)) {
            case DescValueType.OBJECTTYPE: return { type: t2s(desc.getObjectType(key)), value: desc.getObjectValue(key) };
            case DescValueType.LISTTYPE: return desc.getList(key);
            case DescValueType.REFERENCETYPE: return desc.getReference(key);
            case DescValueType.BOOLEANTYPE: return desc.getBoolean(key);
            case DescValueType.STRINGTYPE: return desc.getString(key);
            case DescValueType.INTEGERTYPE: return desc.getInteger(key);
            case DescValueType.LARGEINTEGERTYPE: return desc.getLargeInteger(key);
            case DescValueType.DOUBLETYPE: return desc.getDouble(key);
            case DescValueType.ALIASTYPE: return desc.getPath(key);
            case DescValueType.CLASSTYPE: return desc.getClass(key);
            case DescValueType.UNITDOUBLE: return desc.getUnitDoubleValue(key);
            case DescValueType.ENUMERATEDTYPE: return { type: t2s(desc.getEnumerationType(key)), value: t2s(desc.getEnumerationValue(key)) };
        }
        return null;
    }
}
// Хранит последние длительности генерации в custom options Photoshop и
// использует среднее как ориентир для progress bar следующего запуска.


function Delay() {
    var settingsObj = this;
    this.getDelay = function (key) {
        try { var desc = getCustomOptions(APP.uuid); } catch (_) { }
        if (desc != undefined) descriptorCodec.readInto(settingsObj, desc);
        if (settingsObj[key]) { var sum = 0; for (var i = 0; i < settingsObj[key].length; i++) sum += settingsObj[key][i]; sum = Math.round(sum / settingsObj[key].length); return sum < 1000 ? 1000 : sum; }
        return 15000;
    };
    this.saveDelay = function (key, delay) {
        if (!key) return; delay = Math.max(1, Math.round(Number(delay) || 0));
        if (!(settingsObj[key] instanceof Array)) settingsObj[key] = [];
        if (settingsObj[key].length >= 3) settingsObj[key].splice(0, settingsObj[key].length - 2);
        settingsObj[key].push(delay); putCustomOptions(APP.uuid, descriptorCodec.toDescriptor(settingsObj, true));
    };
}
function Locale() {
    var localized = {
        provider: ["Провайдер", "Provider"], model: ["Модель", "Model"], prompt: ["Промпт", "Prompt"], generate: ["Генерировать", "Generate"],
        translatePrompt: ['Перевести промпт на английский', 'Translate prompt to English'], selection: ['Выделение: ', 'Selection: '],
        resizePresetManagement: ['Профили автомасштаба', 'Auto-resize profiles'], resizePresetNew: ['Новый профиль', 'New profile'],
        resizePresetTitle: ['Профиль автомасштаба', 'Auto-resize profile'], resizePresetPrompt: ['Введите имя профиля автомасштаба:', 'Enter auto-resize profile name:'],
        minimumSide: ['Минимальная короткая сторона', 'Minimum short side'], maximumMp: ['Максимум мегапикселей', 'Maximum megapixels'],
        resizeMinShort: ['мин', 'min'], resizeMaxShort: ['макс', 'max'], presetCopy: [' копия', ' copy'],
        presetDefault: ['по умолчанию', 'default'], presetNew: ['Новый пресет', 'New preset'], presetDelete: ['Удалить пресет', 'Delete preset'],
        presetDeleteConfirmA: ['Удалить пресет «', 'Delete preset ‘'], presetDeleteConfirmB: ['»?', '’?'],
        presetRestore: ['Восстановить текущее содержимое', 'Restore current content'], promptClear: ['Очистить поле', 'Clear field'],
        presetAdd: ['Добавить новый пресет', 'Add new preset'], presetSave: ['Сохранить изменения в текущий пресет', 'Save changes to the current preset'],
        presetNamePrompt: ['Введите имя пресета:', 'Enter preset name:'], errPreset: ['Пресет «%1» уже существует. Перезаписать?', 'Preset “%1” already exists. Overwrite it?'],
        errDefaultPreset: ['Имя «по умолчанию» зарезервировано.', 'The name “default” is reserved.'], errResizePreset: ['Профиль «%1» уже существует. Перезаписать?', 'Profile “%1” already exists. Overwrite it?'],
        selectionLine: ['Выделение: ', 'Selection: '],
        scriptSettings: ["Настройки скрипта", "Script settings"], apiKeys: ["API-ключи", "API keys"], imageSettings: ["Параметры изображения", "Image settings"],
        brushSettings: ["Настройки кисти", "Brush settings"], opacity: ["Непрозрачность кисти", "Brush opacity"],
        apiSettings: ["API", "API"], photoshopSettings: ["Photoshop", "Photoshop"], saveChanges: ["Сохранить изменения", "Save changes"], cancel: ["Отмена", "Cancel"],
        flatten: ["Объединять слои перед отправкой", "Flatten layers before sending"], keepAspectRatioDuringPlace: ["Сохранять пропорции при размещении", "Keep aspect ratio during place"],
        rasterize: ["Растеризовать созданное изображение", "Rasterize generated image"], autoResize: ["Автоматический ресайз входного изображения", "Auto-resize input image"],
        recordSettingsToAction: ["Записывать настройки в экшен", "Record settings to action"], writeLayerMetadata: ["Записывать настройки в метаданные слоя", "Write settings to layer metadata"],
        selectBrush: ["Активировать кисть после генерации", "Select brush after generation"],
        generationTimeout: ['Таймаут генерации, с:', 'Generation timeout, s:'], imageReference: ['Референс', 'Reference image'], noneReference: ['нет', 'none'],
        presetRefreshButton: ['↻', '↻'], presetAddButton: ['+', '+'], presetSaveButton: ['✔', '✔'], presetDeleteButton: ['×', '×'],
        browse: ["Обзор…", "Browse…"], selectReferenceImage: ["Выберите референс", "Select a reference image"],
        keyConfigured: ["ключ настроен", "key configured"], keyMissing: ["ключ не настроен", "key not set"], setKey: ["Указать", "Set"], changeKey: ["Изменить", "Change"], deleteKey: ["Удалить", "Delete"],
        apiKey: ["API-ключ", "API key"], apiKeyNote: ["Ключ будет зашифрован средствами Windows DPAPI и сохранён в настройках Photoshop.", "The key will be encrypted with Windows DPAPI and stored in Photoshop settings."],
        loadLayerMetadata: ["Загрузить настройки из активного слоя", "Load settings from the active layer"],
        progressStartPython: ["Запуск локального Python API…", "Starting local Python API…"], progressHandshake: ["Загрузка карточек моделей…", "Loading model cards…"],
        progressReady: ["Готово", "Ready"], progressInitializing: ["Инициализация…", "Initializing…"], progressTranslate: ["Перевод промпта…", "Translating prompt…"],
        errTranslate: ["Переводчик не вернул результат.", "The translator returned no result."], progressPrepare: ["Подготовка запроса", "Preparing request"],
        progressGenerate: ["Ожидание API", "Waiting for API"], generationProgressTitle: ["Редактирование изображения", "Image editing"], secondsShort: ["с", "s"],
        historyCheckSelection: ["Проверить выделение", "Check selection"], historyPrepareSelection: ["Подготовить изображение", "Prepare image"], historyPlaceResult: ["Вставить результат", "Place result"],
        resize: ["Ресайз", "Resize"], errorOccurred: ["Произошла ошибка", "An error occurred"],
        errorDialogIntro: ["Операция не завершена. Технические подробности:", "The operation was not completed. Technical details:"],
        errorDetails: ["Подробности ошибки", "Error details"], errorDialogTitle: ["Ошибка", "Error"],
        generationWarnings: ["Генерация завершена с предупреждениями:", "Generation completed with warnings:"],
        apiKeyRequired: ["Для выбранного провайдера нужно указать API-ключ в настройках.", "Set an API key for the selected provider in Settings."],
        noModelAvailable: ["Нет доступной модели.", "No model is available."], invalidCard: ["Ошибка встроенной карточки:", "Bundled card error:"],
        settingsBackupRecovered: ["Основной файл настроек прочитать не удалось. Загружена резервная копия:", "The main settings file could not be read. The backup was loaded:"],
        settingsPrimaryReadError: ["Ошибка основного файла:", "Main-file error:"],
        settingsVersionReset: ["Обнаружен файл настроек другой версии. Он проигнорирован; создана чистая конфигурация текущего формата.", "A settings file from another version was found. It was ignored and a clean current-format configuration was created."],
        errMode: ["Документ должен быть в режиме RGB.", "The document must use RGB mode."], errNoProviders: ["Не найдено корректных карточек провайдеров.", "No valid provider cards were found."],
        errNoModels: ["Не найдено корректных карточек моделей.", "No valid model cards were found."], errSilentSettings: ["Параметры тихого запуска больше недействительны. Запустите скрипт повторно с интерфейсом.", "Silent-run settings are no longer valid. Run the script again with the interface."],
        errNoModelSelected: ["Провайдер или модель не выбраны.", "Provider or model is not selected."], errPromptEmpty: ["Промпт не заполнен.", "Prompt is empty."],
        errApiKeyMissing: ["API-ключ выбранного провайдера не настроен.", "The selected provider API key is not configured."], errMetadataModelMissing: ["Модель из метаданных слоя отсутствует в текущих карточках.", "The model stored in layer metadata is absent from the current cards."],
        errTimeout: ["Таймаут должен быть от 30 до 86400 секунд.", "Timeout must be from 30 to 86400 seconds."], errEncryptKey: ["Не удалось зашифровать API-ключ.", "Could not encrypt the API key."],
        errReferenceImageFormat: ["Поддерживаются только JPG, JPEG, PNG и WebP.", "Only JPG, JPEG, PNG, and WebP are supported."],
        errNoResult: ["Python API не вернул результат.", "Python API returned no result."], errResultFile: ["Файл результата не найден:", "Result file was not found:"],
        errFlattenedSourceMissing: ["Не найден подготовленный объединённый слой.", "The prepared flattened layer is missing."], errSaveJpeg: ["Не удалось сохранить входной JPEG.", "Could not save the input JPEG."],
        errPlacedBounds: ["Не удалось определить границы вставленного изображения.", "Could not determine placed-image bounds."], errSelectionEmpty: ["Выделение пустое или находится вне документа.", "The selection is empty or outside the document."],
        errSelectionTooSmall: ["Выделение слишком маленькое. Минимальный размер:", "The selection is too small. Minimum size:"],
        errPythonMissingA: ["Не найден ", "Could not find "], errPythonMissingB: [".pyw или .py рядом с JSX либо в подпапке lib.", ".pyw or .py next to JSX or in the lib subfolder."],
        errPythonStartA: ["Не удалось запустить Python API на ", "Could not start Python API at "], errPythonStartB: [".", "."],
        errApiProtocolA: ["Версия локального API ", "Local API version "], errApiProtocolB: [" несовместима; требуется ", " is incompatible; expected "],
        errListenerPort: ["Не удалось открыть порт ответов ", "Could not open reply port "], errApiConnection: ["Не удалось подключиться к локальному Python API.", "Could not connect to the local Python API."],
        errApiTimeout: ["Истекло время ожидания ответа API.", "Timed out waiting for the API response."], errApiInvalidAnswer: ["Локальный API вернул некорректный JSON:", "Local API returned invalid JSON:"],
        errEmptyApiAnswer: ["Локальный API вернул пустой ответ.", "Local API returned an empty response."],
        errSettingsSaveAfterError: ["После ошибки настройки сохранить не удалось:", "Settings could not be saved after the error:"], errSettingsSaveAfterGeneration: ["Результат создан, но настройки сохранить не удалось:", "The result was created, but settings could not be saved:"],
        errSettingsReadFile: ["Не удалось прочитать файл настроек.", "Could not read the settings file."], errSettingsWriteFile: ["Не удалось записать файл настроек.", "Could not write the settings file."],
        errSettingsReplaceFile: ["Не удалось заменить файл настроек.", "Could not replace the settings file."], errSettingsBackupFile: ["Не удалось создать резервную копию настроек.", "Could not create a settings backup."],
        errSettingsRestoreBackup: ["Не удалось восстановить резервную копию настроек.", "Could not restore the settings backup."], errSettingsUnreadable: ["Файл настроек и его резервная копия повреждены.", "The settings file and its backup are unreadable."],
        errActionSettingsVersion: ["Настройки шага Action относятся к другой версии скрипта. Перезапишите шаг Action текущей версией.", "The Action step settings belong to another script version. Record the Action step again with the current version."],
        errActionProviderMissing: ["Провайдер «%1», записанный в шаге Action, отсутствует в текущих карточках. Перезапишите шаг Action с доступным провайдером и моделью.", "The provider “%1” stored in the Action step is absent from the current cards. Record the Action step again with an available provider and model."],
        errActionModelMissing: ["Модель «%1», записанная в шаге Action, отсутствует в текущих карточках. Перезапишите шаг Action с доступной моделью.", "The model “%1” stored in the Action step is absent from the current cards. Record the Action step again with an available model."],
        jsxLine: ["Строка JSX: ", "JSX line: "]
    }, key;
    for (key in localized) if (localized.hasOwnProperty(key)) this[key] = { ru: localized[key][0], en: localized[key][1] };
}
function calculateSizeFromScale(width, height, scale, multiple) {
    multiple = Math.max(1, parseInt(multiple, 10) || 1);
    scale = Math.max(0.01, Number(scale) || 1);
    var targetWidth = scale != 1 ? Math.floor(width * scale / multiple) * multiple : width,
        targetHeight = scale != 1 ? Math.floor(height * scale / multiple) * multiple : height;
    return {
        width: targetWidth || multiple,
        height: targetHeight || multiple
    };
}
function autoScale(bounds, preset) {
    preset = preset || presets.findResize("", cfg.resizePresets);
    var shortSide = Math.min(bounds.width, bounds.height),
        pixels = bounds.width * bounds.height,
        maxPixels = preset.maxMp * 1000000,
        scale = 1,
        limitedByMaxArea = false;
    if (shortSide < preset.minSide) scale = preset.minSide / shortSide;
    if (pixels * scale * scale > maxPixels) {
        scale = Math.sqrt(maxPixels / pixels);
        limitedByMaxArea = true;
    }
    scale = limitedByMaxArea ? Math.floor(scale * 1000000) / 1000000 : Math.ceil(scale * 1000000) / 1000000;
    if (scale > 8) scale = 8;
    return scale > 0 ? scale : 0.000001;
}
function Presets() {
    var self = this,
        protectedResizeNames = ['1K', '2K', '4K'],
        promptDefaults = { positive: {}, negative: {} };
    this.defaultPrompt = function () { return cloneObj(promptDefaults); };
    this.promptStore = function (config, context) {
        context = context == 'negative' ? 'negative' : 'positive';
        if (!isObjectMap(config.promptPresets)) config.promptPresets = config.data.promptPresets = self.defaultPrompt();
        if (!isObjectMap(config.promptPresets[context])) config.promptPresets[context] = {};
        config.data.promptPresets = config.promptPresets;
        return config.promptPresets[context];
    };
    this.promptText = function (context, text) { return String(text || ''); };
    this.applyPrompt = function (context, currentText, presetText) { return String(presetText || ''); };
    this.createResize = function (name, minSide, maxMp) { return { name: name, minSide: minSide, maxMp: maxMp }; };
    this.defaultResize = function () {
        return [
            self.createResize('1K', 1024, 1.1),
            self.createResize('2K', 2048, 4.2),
            self.createResize('4K', 4096, 16.8)
        ];
    };
    this.findResizeIndex = function (name, list) {
        if (typeof name != 'string') return -1;
        name = name.toUpperCase();
        for (var i = 0; i < list.length; i++) if (String(list[i].name).toUpperCase() == name) return i;
        return -1;
    };
    this.findResize = function (name, list) {
        list = list && list.length ? list : self.defaultResize();
        var index = self.findResizeIndex(name, list);
        return index >= 0 ? list[index] : list[0];
    };
    this.normalizeResizeName = function (name, list) { var preset = self.findResize(name, list); return preset ? preset.name : ''; };
    this.formatResize = function (preset) { return preset.name + ' (' + cardText(str.resizeMinShort) + ' ' + preset.minSide + ' px, ' + cardText(str.resizeMaxShort) + ' ' + preset.maxMp + ' MP)'; };
    this.isProtectedResize = function (name) {
        name = String(name || '').toUpperCase();
        for (var i = 0; i < protectedResizeNames.length; i++) if (name == String(protectedResizeNames[i]).toUpperCase()) return true;
        return false;
    };
}
function createRequestId() { return "api_" + new Date().getTime() + "_" + Math.floor(Math.random() * 1000000000); }
function trimText(value) { return String(value || "").replace(/^\s+|\s+$/g, ""); }
function settingsKey(value) {
    var text = String(value || ""), key = "k", hex;
    for (var i = 0; i < text.length; i++) {
        hex = text.charCodeAt(i).toString(16);
        while (hex.length < 4) hex = "0" + hex;
        key += "_" + hex;
    }
    return key;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function roundTo(value, digits) { var k = Math.pow(10, digits || 0); return Math.round(value * k) / k; }
function arrayContainsCaseInsensitive(array, value) { for (var i = 0; i < array.length; i++) if (String(array[i]).toUpperCase() == String(value).toUpperCase()) return true; return false; }
function isObjectMap(value) { return !!value && typeof value == "object" && !(value instanceof Array); }
function mergeObject(target, source) { if (!isObjectMap(target) || !isObjectMap(source)) return target; for (var key in source) if (source.hasOwnProperty(key)) target[key] = cloneObj(source[key]); return target; }
function cloneObj(source) {
    if (source === null || source === undefined || typeof source != "object") return source;
    if (source instanceof Array) { var array = []; for (var i = 0; i < source.length; i++) array.push(cloneObj(source[i])); return array; }
    var res = {}; for (var key in source) if (source.hasOwnProperty(key)) res[key] = cloneObj(source[key]); return res;
}
function jsonStringify(value) {
    if (value === null) return "null";
    if (value === undefined || typeof value == "function") return undefined;
    if (typeof value == "string") return '"' + escapeJsonString(value) + '"';
    if (typeof value == "number") return isFinite(value) ? String(value) : "null";
    if (typeof value == "boolean") return value ? "true" : "false";
    if (value instanceof Array) { var arr = []; for (var i = 0; i < value.length; i++) { var item = jsonStringify(value[i]); arr.push(item === undefined ? "null" : item); } return "[" + arr.join(",") + "]"; }
    var parts = []; for (var key in value) if (value.hasOwnProperty(key)) { var encoded = jsonStringify(value[key]); if (encoded !== undefined) parts.push('"' + escapeJsonString(key) + '":' + encoded); }
    return "{" + parts.join(",") + "}";
}
function escapeJsonString(value) { return String(value).replace(/\\/g, "\\\\").replace(/\"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/[\u0000-\u001f]/g, function (ch) { var hex = ch.charCodeAt(0).toString(16); while (hex.length < 4) hex = "0" + hex; return "\\u" + hex; }); }
function jsonParse(text) { if (typeof JSON != "undefined" && JSON.parse) return JSON.parse(text); return eval("(" + text + ")"); }

