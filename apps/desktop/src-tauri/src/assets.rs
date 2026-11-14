//! Serves pages from the app folder, read from disk on each request. Every path goes through the
//! plain-names check first. Then the file is opened, and served only if the path that handle
//! really has, after every link and junction, is inside the app folder's own final path; it's read
//! from that same handle. Nothing from the data folder is ever served.

use std::{borrow::Cow, io::Read, path::PathBuf};
use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    Assets, Runtime,
};

pub struct FolderAssets {
    pub app: PathBuf,
    /// The app folder's final path, or None if it couldn't be found, and then nothing is served.
    pub app_final: Option<PathBuf>,
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
        let mut file = std::fs::File::open(path).ok()?;
        let real = crate::platform::final_path(&file)?;
        if !shell_core::folders::within(&real, self.app_final.as_ref()?) {
            return None;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        Some(Cow::Owned(bytes))
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
