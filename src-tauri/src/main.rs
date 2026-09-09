#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use serde_json::Value;

mod usage;

#[tauri::command]
fn default_codex_home() -> String {
    std::env::var("CODEX_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home)
                .join(".codex")
                .to_string_lossy()
                .into_owned()
        })
}

#[tauri::command]
fn analyze_usage(
    codex_home: String,
    days: i32,
    from_timestamp: Option<i64>,
    to_timestamp: Option<i64>,
) -> Result<Value, String> {
    usage::analyze(codex_home.trim(), days, from_timestamp, to_timestamp)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![default_codex_home, analyze_usage])
        .run(tauri::generate_context!())
        .expect("error while running Codex Usage Monitor");
}

fn main() {
    run();
}
