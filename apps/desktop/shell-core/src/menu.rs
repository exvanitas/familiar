//! Tray menu specs. The app writes the menu. The exe checks it and adds Quit, which must work with
//! core dead. Menu ids starting `shell:` are the exe's.

use std::collections::HashSet;

pub const QUIT_ID: &str = "shell:quit";
pub const QUIT_LABEL: &str = "Quit";
const MAX_DEPTH: usize = 4;
const MAX_ITEMS: usize = 200;
const MAX_LABEL: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Item {
    pub id: String,
    pub label: String,
    pub checked: Option<bool>,
    pub enabled: Option<bool>,
    pub separator: bool,
    pub items: Option<Vec<Item>>,
}

impl Item {
    pub fn is_enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }
}

fn check(items: &[Item], depth: usize, seen: &mut HashSet<String>, count: &mut usize) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("menu is too deep".into());
    }
    for it in items {
        *count += 1;
        if *count > MAX_ITEMS {
            return Err("menu is too long".into());
        }
        if it.separator {
            continue;
        }
        if it.label.is_empty() {
            return Err("menu item has no label".into());
        }
        if it.label.chars().count() > MAX_LABEL {
            return Err("menu label is too long".into());
        }
        if let Some(sub) = &it.items {
            check(sub, depth + 1, seen, count)?;
            continue;
        }
        if it.id.is_empty() {
            return Err("menu item has no id".into());
        }
        if it.id.starts_with("shell:") {
            return Err("menu ids starting shell: are the exe's".into());
        }
        if !seen.insert(it.id.clone()) {
            return Err("menu id is used twice".into());
        }
    }
    Ok(())
}

/// The menu as the tray shows it: the app's items, checked, with Quit always last.
pub fn with_quit(items: Vec<Item>) -> Result<Vec<Item>, String> {
    check(&items, 1, &mut HashSet::new(), &mut 0)?;
    let mut out = items;
    if !out.is_empty() {
        out.push(Item { separator: true, ..Item::default() });
    }
    out.push(Item { id: QUIT_ID.into(), label: QUIT_LABEL.into(), ..Item::default() });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, label: &str) -> Item {
        Item { id: id.into(), label: label.into(), ..Item::default() }
    }

    #[test]
    fn quit_is_always_last_and_cannot_be_taken_away() {
        let empty = with_quit(vec![]).unwrap();
        assert_eq!(empty.len(), 1);
        assert_eq!(empty[0].id, QUIT_ID);
        let m = with_quit(vec![item("a", "A")]).unwrap();
        assert_eq!(m.iter().map(|i| i.separator).collect::<Vec<_>>(), [false, true, false]);
        assert_eq!(m.last().unwrap().id, QUIT_ID);
    }

    #[test]
    fn an_app_item_cannot_pose_as_the_exe() {
        assert!(with_quit(vec![item(QUIT_ID, "Stay")]).is_err());
        let sub = Item { label: "Sub".into(), items: Some(vec![item("shell:x", "X")]), ..Item::default() };
        assert!(with_quit(vec![sub]).is_err());
    }

    #[test]
    fn submenus_and_flags() {
        let sub = Item {
            label: "More".into(),
            items: Some(vec![
                Item { checked: Some(true), ..item("a", "A") },
                Item { separator: true, ..Item::default() },
                Item { enabled: Some(false), ..item("b", "B") },
            ]),
            ..Item::default()
        };
        let m = with_quit(vec![sub]).unwrap();
        let sub = m[0].items.as_ref().unwrap();
        assert_eq!(sub[0].checked, Some(true));
        assert!(sub[1].separator);
        assert!(!sub[2].is_enabled());
    }

    #[test]
    fn bad_menus_are_refused() {
        assert!(with_quit(vec![item("a", "")]).is_err(), "no label");
        assert!(with_quit(vec![item("", "A")]).is_err(), "no id");
        assert!(with_quit(vec![item("a", "A"), item("a", "B")]).is_err(), "twice");
        assert!(with_quit(vec![item("a", &"x".repeat(129))]).is_err(), "long label");
        let mut deep = item("x", "X");
        for _ in 0..5 {
            deep = Item { label: "S".into(), items: Some(vec![deep]), ..Item::default() };
        }
        assert!(with_quit(vec![deep]).is_err(), "too deep");
        assert!(with_quit((0..201).map(|i| item(&i.to_string(), "I")).collect()).is_err(), "too long");
    }
}
