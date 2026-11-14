//! The tray icon. Core writes the menu with `tray_set`. Quit is the exe's own and handled here, so
//! it works with core dead. Clicks reach core over its channel, never as events.

use crate::shell::{self, Shell};
use serde::Deserialize;
use shell_core::menu::{self, Item, QUIT_ID};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

const ID: &str = "main";
/// The exe's own item, shown only while three refusals have stopped the confirms.
pub const ASK_AGAIN_ID: &str = "shell:ask-again";
/// With `a` as its access key, so the menu can be answered from the keyboard too.
const ASK_AGAIN_LABEL: &str = "Let Familiar &ask again";

/// The app's last menu, so the exe can rebuild the tray when its own items change.
static APP_ITEMS: std::sync::Mutex<Vec<Item>> = std::sync::Mutex::new(Vec::new());

/// The menu as shown: the app's items, then the exe's: "Let Familiar ask again" while asking is
/// stopped, and Quit last.
fn full_menu(app: &AppHandle, items: Vec<Item>) -> Result<Vec<Item>, String> {
    let mut out = menu::with_quit(items)?;
    if crate::confirm::stopped(app) {
        let quit = out.pop();
        out.push(Item { id: ASK_AGAIN_ID.into(), label: ASK_AGAIN_LABEL.into(), ..Item::default() });
        out.extend(quit);
    }
    Ok(out)
}

/// Rebuilds the tray menu, after the exe's own items changed.
pub fn refresh(app: &AppHandle) {
    let items = crate::shell::lock(&APP_ITEMS).clone();
    let Ok(items) = full_menu(app, items) else { return };
    if let (Some(tray), Ok(m)) = (app.tray_by_id(ID), build_menu(app, &items)) {
        let _ = tray.set_menu(Some(m));
    }
}

/// A menu item as a page sends it.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ItemSpec {
    id: String,
    label: String,
    checked: Option<bool>,
    enabled: Option<bool>,
    separator: bool,
    items: Option<Vec<ItemSpec>>,
}

impl From<ItemSpec> for Item {
    fn from(s: ItemSpec) -> Item {
        Item { id: s.id, label: s.label, checked: s.checked, enabled: s.enabled, separator: s.separator, items: s.items.map(|v| v.into_iter().map(Item::from).collect()) }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TraySpec {
    tooltip: Option<String>,
    icon: Option<String>,
    #[serde(default)]
    items: Vec<ItemSpec>,
}

fn add(app: &AppHandle, items: &[Item], to: &dyn Fn(&dyn IsMenuItem<Wry>) -> tauri::Result<()>) -> tauri::Result<()> {
    for it in items {
        if it.separator {
            to(&PredefinedMenuItem::separator(app)?)?;
        } else if let Some(sub) = &it.items {
            let s = Submenu::new(app, &it.label, it.is_enabled())?;
            add(app, sub, &|x| s.append(x))?;
            to(&s)?;
        } else if let Some(checked) = it.checked {
            to(&CheckMenuItem::with_id(app, &it.id, &it.label, it.is_enabled(), checked, None::<&str>)?)?;
        } else {
            to(&MenuItem::with_id(app, &it.id, &it.label, it.is_enabled(), None::<&str>)?)?;
        }
    }
    Ok(())
}

fn build_menu(app: &AppHandle, items: &[Item]) -> tauri::Result<Menu<Wry>> {
    let m = Menu::new(app)?;
    add(app, items, &|x| m.append(x))?;
    Ok(m)
}

/// A tray with only Quit, up before any page has run.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let items = menu::with_quit(vec![]).map_err(|e| tauri::Error::Anyhow(std::io::Error::other(e).into()))?;
    let mut tray = TrayIconBuilder::with_id(ID).menu(&build_menu(app, &items)?).tooltip("Familiar").show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, e| {
        if e.id().as_ref() == QUIT_ID {
            shell::quit(app, "tray");
        } else if e.id().as_ref() == ASK_AGAIN_ID {
            crate::confirm::reenable(app);
        } else {
            app.state::<Shell>().tell_core(serde_json::json!({ "t": "tray", "id": e.id().as_ref() }));
        }
    })
    .on_tray_icon_event(|tray, e| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            tray.app_handle().state::<Shell>().tell_core(serde_json::json!({ "t": "tray-click" }));
        }
    })
    .build(app)?;
    Ok(())
}

/// A PNG from the app folder.
fn app_image(app: &AppHandle, file: &str) -> Result<Image<'static>, String> {
    let shell = app.state::<Shell>();
    let path = shell_core::paths::inside(&shell.app_dir, file).filter(|_| !file.is_empty() && file.ends_with(".png")).ok_or("icon must be a .png of the app folder")?;
    let bytes = std::fs::read(path).map_err(|_| "icon not found".to_string())?;
    Image::from_bytes(&bytes).map(|i| i.to_owned()).map_err(|e| e.to_string())
}

pub fn set(app: &AppHandle, spec: TraySpec) -> Result<(), String> {
    let app_items: Vec<Item> = spec.items.into_iter().map(Item::from).collect();
    let items = full_menu(app, app_items.clone())?;
    *crate::shell::lock(&APP_ITEMS) = app_items;
    let tray = app.tray_by_id(ID).ok_or("no tray")?;
    if let Some(file) = spec.icon {
        tray.set_icon(Some(app_image(app, &file)?)).map_err(|e| e.to_string())?;
    }
    if let Some(t) = spec.tooltip {
        tray.set_tooltip(Some(t.chars().take(127).collect::<String>())).map_err(|e| e.to_string())?;
    }
    tray.set_menu(Some(build_menu(app, &items).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())
}
