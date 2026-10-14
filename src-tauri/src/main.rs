#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use serde_json::Value;
use tauri::Manager;

mod pricing;
mod usage;

fn price_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("model-prices.json"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_model_prices(app: tauri::AppHandle) -> Result<Value, String> {
    let path = price_path(&app)?;
    Ok(
        serde_json::json!({ "prices": pricing::load(&path)?, "defaults": pricing::defaults(), "path": path }),
    )
}

#[tauri::command]
fn save_model_prices(app: tauri::AppHandle, prices: pricing::PriceTable) -> Result<(), String> {
    pricing::save(&price_path(&app)?, prices)
}

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
    app: tauri::AppHandle,
    codex_home: String,
    days: i32,
    from_timestamp: Option<i64>,
    to_timestamp: Option<i64>,
) -> Result<Value, String> {
    let prices = pricing::load(&price_path(&app)?)?;
    usage::analyze(
        codex_home.trim(),
        days,
        from_timestamp,
        to_timestamp,
        &prices,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_codex_home,
            analyze_usage,
            get_model_prices,
            save_model_prices
        ])
        .run(tauri::generate_context!())
        .expect("error while running Codex Usage Monitor");
}

fn main() {
    run();
}
