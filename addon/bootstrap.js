/**
 * Bootstrap entry point for Zotero 7/8/9 compatibility.
 */

if (typeof Zotero == "undefined") {
  var Zotero;
}

var chromeHandle;

async function waitForZotero() {
  if (typeof Zotero != "undefined") {
    await Zotero.initializationPromise;
  }

  var windows = Services.wm.getEnumerator("navigator:browser");
  var found = false;
  while (windows.hasMoreElements()) {
    let win = windows.getNext();
    if (win.Zotero) {
      Zotero = win.Zotero;
      found = true;
      break;
    }
  }
  if (!found) {
    await new Promise((resolve) => {
      var listener = {
        onOpenWindow: function (aWindow) {
          let domWindow = aWindow
            .QueryInterface(Ci.nsIInterfaceRequestor)
            .getInterface(Ci.nsIDOMWindowInternal || Ci.nsIDOMWindow);
          domWindow.addEventListener(
            "load",
            function () {
              domWindow.removeEventListener("load", arguments.callee, false);
              if (domWindow.Zotero) {
                Services.wm.removeListener(listener);
                Zotero = domWindow.Zotero;
                resolve();
              }
            },
            false
          );
        },
      };
      Services.wm.addListener(listener);
    });
  }
  await Zotero.initializationPromise;
}

function install(data, reason) {}

function _log(msg) {
  try {
    Services.console.logStringMessage("[RA] " + msg);
  } catch (e) {}
  // Also append to /tmp so we can inspect from a terminal — invaluable when
  // module-load throws and the menu never registers.
  try {
    const path = "/tmp/ra-bootstrap.log";
    const file = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile);
    file.initWithPath(path);
    const stream = Components.classes["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Components.interfaces.nsIFileOutputStream);
    stream.init(file, 0x02 | 0x08 | 0x10, 0o666, 0); // WRITE | CREATE | APPEND
    const line = "[RA " + new Date().toISOString() + "] " + msg + "\n";
    const bytes = new TextEncoder().encode(line);
    stream.write(String.fromCharCode.apply(null, bytes), bytes.length);
    stream.close();
  } catch (e) {}
}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  _log("bootstrap startup called");
  await waitForZotero();
  _log("waitForZotero done");

  if (!rootURI) {
    rootURI = resourceURI.spec;
  }

  try {
    var aomStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    var manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "__addonRef__", rootURI + "content/"],
      ["locale", "__addonRef__", "en-US", rootURI + "locale/en-US/"],
      ["locale", "__addonRef__", "zh-CN", rootURI + "locale/zh-CN/"],
    ]);
    _log("Chrome registered");
  } catch (e) {
    _log("Chrome registration failed: " + e);
  }

  // Console stub: Mozilla's scriptloader sandbox doesn't inject `console`
  // by default, but bundled NPM dependencies (e.g. cytoscape) routinely
  // reference it at module-evaluation time. Without this stub the whole
  // bundle throws `console is not defined` and the plugin fails to load
  // silently — including the Tools-menu registration.
  const consoleStub = {
    log: function () { try { Zotero.debug("[RA console] " + Array.from(arguments).join(" ")); } catch (e) {} },
    warn: function () { try { Zotero.debug("[RA console.warn] " + Array.from(arguments).join(" ")); } catch (e) {} },
    error: function () { try { Zotero.debug("[RA console.error] " + Array.from(arguments).join(" ")); } catch (e) {} },
    info: function () { try { Zotero.debug("[RA console.info] " + Array.from(arguments).join(" ")); } catch (e) {} },
    debug: function () { try { Zotero.debug("[RA console.debug] " + Array.from(arguments).join(" ")); } catch (e) {} },
    trace: function () {},
    group: function () {},
    groupEnd: function () {},
    assert: function () {},
    table: function () {},
    time: function () {},
    timeEnd: function () {},
  };

  const ctx = {
    rootURI,
    __dirname: "",
    __filename: "",
    console: consoleStub,
  };
  ctx._globalThis = ctx;

  try {
    Services.scriptloader.loadSubScript(
      `${rootURI}/content/scripts/__addonRef__.js`,
      ctx
    );
    _log("SubScript loaded");
  } catch (e) {
    _log("SubScript load failed: " + e);
    return;
  }

  const addonInstance = Zotero.ReadingAssistant;
  _log("addonInstance = " + typeof addonInstance);
  if (addonInstance && addonInstance.hooks && addonInstance.hooks.onStartup) {
    try {
      await addonInstance.hooks.onStartup();
      _log("onStartup done");
    } catch (e) {
      _log("onStartup failed: " + e);
    }
  } else {
    _log("No hooks.onStartup found");
  }

  // CRITICAL: If windows are already open, onMainWindowLoad won't fire automatically.
  // We must manually call it for all existing main windows.
  _log("Checking existing windows...");
  try {
    var wins = Services.wm.getEnumerator("navigator:browser");
    while (wins.hasMoreElements()) {
      let win = wins.getNext();
      if (win.Zotero) {
        _log("Manually calling onMainWindowLoad for existing window");
        await onMainWindowLoad({ window: win }, reason);
      }
    }
  } catch (e) {
    _log("Window iteration error: " + e);
  }

  _log("startup complete");
}

async function onMainWindowLoad({ window }, reason) {
  _log("onMainWindowLoad called");
  const addonInstance = Zotero.ReadingAssistant;
  if (addonInstance && addonInstance.hooks && addonInstance.hooks.onMainWindowLoad) {
    try {
      await addonInstance.hooks.onMainWindowLoad(window);
      _log("onMainWindowLoad done");
    } catch (e) {
      _log("onMainWindowLoad failed: " + e);
    }
  } else {
    _log("No hooks.onMainWindowLoad found");
  }
}

async function onMainWindowUnload({ window }, reason) {
  const addonInstance = Zotero.ReadingAssistant;
  if (addonInstance && addonInstance.hooks && addonInstance.hooks.onMainWindowUnload) {
    try {
      await addonInstance.hooks.onMainWindowUnload(window);
    } catch (e) {
      _log("onMainWindowUnload failed: " + e);
    }
  }
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  const addonInstance = Zotero.ReadingAssistant;
  if (addonInstance && addonInstance.hooks && addonInstance.hooks.onShutdown) {
    try {
      addonInstance.hooks.onShutdown();
    } catch (e) {
      _log("onShutdown failed: " + e);
    }
  }

  if (typeof Zotero === "undefined") {
    Zotero = Components.classes["@zotero.org/Zotero;1"].getService(
      Components.interfaces.nsISupports
    ).wrappedJSObject;
  }

  try {
    Cc["@mozilla.org/intl/stringbundle;1"]
      .getService(Components.interfaces.nsIStringBundleService)
      .flushBundles();
  } catch (e) {}

  try {
    Cu.unload(`${rootURI}/content/scripts/__addonRef__.js`);
  } catch (e) {}

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
