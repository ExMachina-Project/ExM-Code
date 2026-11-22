#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use exm_code_runtime::{
    AgentRuntime as DesktopRuntime, ManualEdit, SaveSettings, SessionUpdate, TaskProgress,
};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
use tauri::{Manager, State};

#[tauri::command]
fn client_info() -> Value {
    serde_json::json!({"platform":if cfg!(any(target_os = "android", target_os = "ios")) { "mobile" } else { "desktop" }})
}

#[tauri::command]
fn recent_projects(runtime: State<'_, DesktopRuntime>) -> Value {
    runtime.recent_projects()
}

#[tauri::command]
fn get_settings(runtime: State<'_, DesktopRuntime>) -> Result<Value, String> {
    runtime.get_settings()
}

#[tauri::command]
fn save_settings(runtime: State<'_, DesktopRuntime>, input: SaveSettings) -> Result<Value, String> {
    runtime.save_settings(input)
}

#[tauri::command]
fn workspace_info(runtime: State<'_, DesktopRuntime>) -> Result<Value, String> {
    runtime.workspace_info()
}

#[tauri::command]
fn has_workspace(runtime: State<'_, DesktopRuntime>) -> bool {
    runtime.has_workspace()
}

#[tauri::command]
fn select_workspace(runtime: State<'_, DesktopRuntime>, path: String) -> Result<Value, String> {
    runtime.select_workspace(PathBuf::from(path))
}

#[tauri::command]
fn list_files(runtime: State<'_, DesktopRuntime>, path: Option<String>) -> Result<Value, String> {
    runtime.list_files(path.unwrap_or_default())
}

#[tauri::command]
fn search_files(runtime: State<'_, DesktopRuntime>, query: String) -> Result<Value, String> {
    runtime.search_files(query)
}

#[tauri::command]
fn read_file(runtime: State<'_, DesktopRuntime>, path: String) -> Result<Value, String> {
    runtime.read_file(path)
}

#[tauri::command]
fn list_sessions(runtime: State<'_, DesktopRuntime>) -> Result<Value, String> {
    runtime.list_sessions()
}

#[tauri::command]
fn create_session(
    runtime: State<'_, DesktopRuntime>,
    mode: Option<String>,
) -> Result<Value, String> {
    runtime.create_session(mode.unwrap_or_else(|| "code".into()))
}

#[tauri::command]
fn update_session(
    runtime: State<'_, DesktopRuntime>,
    id: String,
    input: SessionUpdate,
) -> Result<Value, String> {
    runtime.update_session(id, input)
}

#[tauri::command]
fn delete_session(runtime: State<'_, DesktopRuntime>, id: String) -> Result<Value, String> {
    runtime.delete_session(id)
}

#[tauri::command]
fn export_session(runtime: State<'_, DesktopRuntime>, id: String) -> Result<Value, String> {
    runtime.export_session(id)
}

#[tauri::command]
fn search_content(runtime: State<'_, DesktopRuntime>, query: String) -> Result<Value, String> {
    runtime.search_content(query)
}

#[tauri::command]
fn active_tasks(runtime: State<'_, DesktopRuntime>) -> Result<Value, String> {
    runtime.active_tasks()
}

#[tauri::command]
fn stage_edit(runtime: State<'_, DesktopRuntime>, input: ManualEdit) -> Result<Value, String> {
    runtime.stage_edit(input)
}

#[tauri::command]
fn list_messages(runtime: State<'_, DesktopRuntime>, id: String) -> Result<Value, String> {
    runtime.list_messages(id)
}

#[tauri::command]
async fn chat(
    runtime: State<'_, DesktopRuntime>,
    request_id: String,
    session_id: String,
    mode: String,
    message: String,
    context_path: Option<String>,
    on_event: tauri::ipc::Channel<TaskProgress>,
) -> Result<Value, String> {
    runtime
        .chat_with_events(
            request_id,
            session_id,
            mode,
            message,
            context_path,
            Arc::new(move |progress| {
                let _ = on_event.send(progress);
            }),
        )
        .await
}

#[tauri::command]
fn cancel_chat(runtime: State<'_, DesktopRuntime>, request_id: String) -> Result<Value, String> {
    runtime.cancel_chat(request_id)
}

#[tauri::command]
fn apply_proposal(
    runtime: State<'_, DesktopRuntime>,
    proposal_id: String,
) -> Result<Value, String> {
    runtime.decide_proposal(proposal_id, true)
}

#[tauri::command]
fn dismiss_proposal(
    runtime: State<'_, DesktopRuntime>,
    proposal_id: String,
) -> Result<Value, String> {
    runtime.decide_proposal(proposal_id, false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let app_data = app.path().app_data_dir()?;
                let runtime = DesktopRuntime::open(app_data)?;
                app.manage(runtime);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            client_info,
            recent_projects,
            delete_session,
            export_session,
            search_content,
            active_tasks,
            stage_edit,
            get_settings,
            save_settings,
            workspace_info,
            has_workspace,
            select_workspace,
            list_files,
            search_files,
            read_file,
            list_sessions,
            create_session,
            update_session,
            list_messages,
            chat,
            cancel_chat,
            apply_proposal,
            dismiss_proposal
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ExM Code desktop client");
}
