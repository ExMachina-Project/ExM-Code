use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("workspace path must be relative")]
    AbsolutePath,
    #[error("path escapes the selected workspace")]
    OutsideWorkspace,
    #[error("agent state, credentials and symlinks are not accessible as workspace files")]
    ProtectedPath,
    #[error("path is not a file")]
    NotAFile,
    #[error("path is not a directory")]
    NotADirectory,
    #[error("file changed since this proposal was created; reopen and review it")]
    Conflict,
    #[error("path is too large to read (limit: {0} bytes)")]
    TooLarge(usize),
    #[error("invalid UTF-8 file")]
    InvalidUtf8,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub extension: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
    excluded: Vec<PathBuf>,
}

impl Workspace {
    pub fn new(root: impl AsRef<Path>) -> std::io::Result<Self> {
        let root = root.as_ref();
        fs::create_dir_all(root)?;
        Ok(Self {
            root: fs::canonicalize(root)?,
            excluded: Vec::new(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Hide runtime-owned private data even when a parent directory is selected.
    pub fn protect(&mut self, path: impl AsRef<Path>) {
        self.excluded.push(path.as_ref().to_path_buf());
    }

    fn resolve(&self, relative: &str) -> Result<PathBuf, WorkspaceError> {
        let candidate = Path::new(relative);
        if candidate.is_absolute() {
            return Err(WorkspaceError::AbsolutePath);
        }
        if candidate
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
        {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        let mut cursor = self.root.clone();
        for component in candidate.components() {
            if let Component::Normal(name) = component {
                if protected_name(&name.to_string_lossy()) {
                    return Err(WorkspaceError::ProtectedPath);
                }
                cursor.push(name);
                if let Ok(metadata) = fs::symlink_metadata(&cursor) {
                    if metadata.file_type().is_symlink() {
                        return Err(WorkspaceError::ProtectedPath);
                    }
                }
            }
        }
        let full = self.root.join(candidate);
        if self.excluded.iter().any(|path| full.starts_with(path)) {
            return Err(WorkspaceError::ProtectedPath);
        }
        // Resolve existing parents too: a symlink inside the workspace must not escape its boundary.
        let mut cursor = full.as_path();
        while !cursor.exists() {
            cursor = cursor.parent().ok_or(WorkspaceError::OutsideWorkspace)?;
            if cursor == self.root.parent().unwrap_or(&self.root) {
                break;
            }
        }
        let resolved = fs::canonicalize(cursor)?;
        if !resolved.starts_with(&self.root) {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        Ok(full)
    }

    pub fn list(
        &self,
        relative: &str,
        max_entries: usize,
    ) -> Result<Vec<FileEntry>, WorkspaceError> {
        let dir = self.resolve(relative)?;
        if !dir.is_dir() {
            return Err(WorkspaceError::NotADirectory);
        }
        let mut entries = fs::read_dir(dir)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                if protected_name(&name)
                    || matches!(name.as_str(), "node_modules" | "target" | "dist" | "vendor")
                {
                    return None;
                }
                let path = entry.path();
                if self
                    .excluded
                    .iter()
                    .any(|excluded| path.starts_with(excluded))
                {
                    return None;
                }
                let metadata = fs::symlink_metadata(&path).ok()?;
                // Never follow symlinks for workspace browsing.
                if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
                    return None;
                }
                let is_dir = metadata.is_dir();
                let relative_path = path
                    .strip_prefix(&self.root)
                    .ok()?
                    .to_string_lossy()
                    .replace('\\', "/");
                let extension = path
                    .extension()
                    .map(|ext| ext.to_string_lossy().to_string());
                Some(FileEntry {
                    name,
                    path: relative_path,
                    is_dir,
                    size: metadata.len(),
                    extension,
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        entries.truncate(max_entries);
        Ok(entries)
    }

    pub fn read(&self, relative: &str, limit: usize) -> Result<String, WorkspaceError> {
        let path = self.resolve(relative)?;
        if !path.is_file() {
            return Err(WorkspaceError::NotAFile);
        }
        let metadata = fs::metadata(&path)?;
        if metadata.len() > limit as u64 {
            return Err(WorkspaceError::TooLarge(limit));
        }
        let file = fs::File::open(path)?;
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(WorkspaceError::TooLarge(limit));
        }
        let text = String::from_utf8(bytes).map_err(|_| WorkspaceError::InvalidUtf8)?;
        if text.contains('\0') {
            return Err(WorkspaceError::InvalidUtf8);
        }
        Ok(text)
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<(String, String)>, WorkspaceError> {
        let needle = query.to_lowercase();
        if needle.trim().is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let mut stack = vec![String::new()];
        let mut matches = Vec::new();
        let mut visited = 0;
        let mut scanned_bytes = 0_u64;
        while let Some(dir) = stack.pop() {
            for entry in self.list(&dir, 500)? {
                visited += 1;
                if visited > 5_000 {
                    return Ok(matches);
                }
                if entry.is_dir {
                    stack.push(entry.path);
                    continue;
                }
                if entry.size > 256 * 1024 {
                    continue;
                }
                scanned_bytes = scanned_bytes.saturating_add(entry.size);
                if scanned_bytes > 16 * 1024 * 1024 {
                    return Ok(matches);
                }
                if let Ok(contents) = self.read(&entry.path, 256 * 1024) {
                    for (index, line) in contents.lines().enumerate() {
                        if line.to_lowercase().contains(&needle) {
                            matches.push((
                                entry.path.clone(),
                                format!(
                                    "{}: {}",
                                    index + 1,
                                    line.trim().chars().take(400).collect::<String>()
                                ),
                            ));
                            if matches.len() >= limit {
                                return Ok(matches);
                            }
                        }
                    }
                }
            }
        }
        Ok(matches)
    }

    pub fn find_files(&self, query: &str, limit: usize) -> Result<Vec<FileEntry>, WorkspaceError> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let mut stack = vec![String::new()];
        let mut matches = Vec::new();
        let mut visited = 0;
        while let Some(dir) = stack.pop() {
            for entry in self.list(&dir, 500)? {
                visited += 1;
                if visited > 10_000 || matches.len() >= limit {
                    return Ok(matches);
                }
                if entry.is_dir {
                    stack.push(entry.path.clone());
                }
                if entry.name.to_lowercase().contains(&needle) {
                    matches.push(entry);
                }
            }
        }
        Ok(matches)
    }

    pub fn validate_write_path(&self, relative: &str) -> Result<(), WorkspaceError> {
        let path = self.resolve(relative)?;
        if path.is_dir() {
            return Err(WorkspaceError::NotAFile);
        }
        if let Some(parent) = path.parent() {
            let mut existing = parent;
            while !existing.exists() {
                existing = existing.parent().ok_or(WorkspaceError::OutsideWorkspace)?;
            }
            if !fs::canonicalize(existing)?.starts_with(&self.root) {
                return Err(WorkspaceError::OutsideWorkspace);
            }
        }
        Ok(())
    }

    pub fn snapshot(&self, relative: &str) -> Result<Option<String>, WorkspaceError> {
        let path = self.resolve(relative)?;
        match path.try_exists()? {
            true => self.read(relative, 512 * 1024).map(Some),
            false => Ok(None),
        }
    }

    pub fn apply_if_unchanged(
        &self,
        relative: &str,
        expected: &str,
        expected_exists: bool,
        contents: &str,
    ) -> Result<(), WorkspaceError> {
        if contents.len() > 512 * 1024 {
            return Err(WorkspaceError::TooLarge(512 * 1024));
        }
        if contents.contains('\0') {
            return Err(WorkspaceError::InvalidUtf8);
        }
        let expected = expected_exists.then_some(expected);
        if self.snapshot(relative)?.as_deref() != expected {
            return Err(WorkspaceError::Conflict);
        }
        self.validate_write_path(relative)?;
        let path = self.resolve(relative)?;
        let parent = path.parent().ok_or(WorkspaceError::OutsideWorkspace)?;
        fs::create_dir_all(parent)?;
        self.resolve(relative)?;
        let mut builder = tempfile::Builder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(fs::Permissions::from_mode(0o666));
        }
        let mut temporary = builder.prefix(".exm-code-tmp-").tempfile_in(parent)?;
        temporary.write_all(contents.as_bytes())?;
        if expected.is_some() {
            temporary
                .as_file()
                .set_permissions(fs::metadata(&path)?.permissions())?;
        }
        temporary.as_file().sync_all()?;
        if self.snapshot(relative)?.as_deref() != expected {
            return Err(WorkspaceError::Conflict);
        }
        let result = if expected.is_some() {
            temporary.persist(path)
        } else {
            temporary.persist_noclobber(path)
        };
        result.map_err(|error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                WorkspaceError::Conflict
            } else {
                WorkspaceError::Io(error.error)
            }
        })?;
        Ok(())
    }
}

fn protected_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".exm-code"
            | ".git"
            | ".ssh"
            | ".aws"
            | ".gnupg"
            | ".npmrc"
            | ".netrc"
            | ".pypirc"
            | ".envrc"
            | ".git-credentials"
            | ".vault-token"
            | ".dockerconfigjson"
            | "id_rsa"
            | "id_ed25519"
            | "terraform.tfstate"
    ) || ((name == ".env" || name.starts_with(".env."))
        && !matches!(
            name.as_str(),
            ".env.example" | ".env.sample" | ".env.template"
        ))
        || name.starts_with(".exm-code-tmp-")
        || name.ends_with(".pem")
        || name.ends_with(".key")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_parent_traversal_and_absolute_paths() {
        let tmp = tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        assert!(matches!(
            ws.read("../secret", 1024),
            Err(WorkspaceError::OutsideWorkspace)
        ));
        assert!(matches!(
            ws.read("/etc/passwd", 1024),
            Err(WorkspaceError::AbsolutePath)
        ));
    }

    #[test]
    fn reads_and_lists_only_workspace_files() {
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("main.rs"), "fn main() {}\n").unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        assert_eq!(ws.read("main.rs", 1024).unwrap(), "fn main() {}\n");
        assert_eq!(
            ws.list("", 100)
                .unwrap()
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["main.rs"]
        );
    }

    #[test]
    fn filename_search_descends_into_unexpanded_directories() {
        let tmp = tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("src/components")).unwrap();
        fs::write(tmp.path().join("src/components/App.tsx"), "export {};").unwrap();
        let workspace = Workspace::new(tmp.path()).unwrap();
        assert_eq!(
            workspace.find_files("app.tsx", 20).unwrap()[0].path,
            "src/components/App.tsx"
        );
    }

    #[test]
    fn credentials_and_agent_state_are_not_workspace_context() {
        let tmp = tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        fs::create_dir(tmp.path().join(".exm-code")).unwrap();
        fs::write(tmp.path().join(".exm-code/config.json"), "secret").unwrap();
        fs::write(tmp.path().join(".env"), "SECRET=1").unwrap();
        fs::write(tmp.path().join(".env.example"), "SECRET=").unwrap();
        assert!(matches!(
            ws.read(".exm-code/config.json", 1024),
            Err(WorkspaceError::ProtectedPath)
        ));
        assert!(ws.read(".env", 1024).is_err());
        assert!(ws.read(".env.example", 1024).is_ok());
        assert!(ws
            .apply_if_unchanged(".git/config", "", false, "no")
            .is_err());
        assert_eq!(ws.list("", 100).unwrap().len(), 1);
    }

    #[test]
    fn approved_edits_do_not_overwrite_changed_files() {
        let tmp = tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        ws.apply_if_unchanged("src/main.rs", "", false, "original")
            .unwrap();
        ws.apply_if_unchanged("src/main.rs", "original", true, "reviewed")
            .unwrap();
        assert!(matches!(
            ws.apply_if_unchanged("src/main.rs", "original", true, "stale"),
            Err(WorkspaceError::Conflict)
        ));
        assert_eq!(ws.read("src/main.rs", 1024).unwrap(), "reviewed");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_including_dangling_links_and_linked_parents() {
        let tmp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("link")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("missing"), tmp.path().join("dangling"))
            .unwrap();
        assert!(ws
            .apply_if_unchanged("link/file.txt", "", false, "no")
            .is_err());
        assert!(ws.apply_if_unchanged("dangling", "", false, "no").is_err());
        assert!(ws.list("link", 100).is_err());
        assert!(!outside.path().join("missing").exists());
    }
}
