//! Serves pages from the app folder, read from disk on each request. Every path goes through the
//! plain-names check first. Nothing from the data folder is ever served.

use std::{borrow::Cow, path::PathBuf};
use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    Assets, Runtime,
};

pub struct FolderAssets {
    pub app: PathBuf,
}

impl<R: Runtime> Assets<R> for FolderAssets {
    /// Tauri cuts the query string and fragment off before it gets here. A key starts with `/`.
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let key = key.as_ref();
        let rel = key.strip_prefix('/').unwrap_or(key);
        if rel.is_empty() {
            return None;
        }
        let path = shell_core::paths::inside(&self.app, rel)?;
        std::fs::read(path).ok().map(Cow::Owned)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
