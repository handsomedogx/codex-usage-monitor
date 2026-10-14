use std::{collections::BTreeMap, fs, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelPrice {
    pub input: f64,
    pub cached_input: f64,
    pub output: f64,
}

pub type PriceTable = BTreeMap<String, ModelPrice>;

pub fn defaults() -> PriceTable {
    serde_json::from_str(include_str!("../default-prices.json"))
        .expect("valid bundled model prices")
}

pub fn normalize_model(raw: &str) -> String {
    let model = raw.trim().to_lowercase();
    let model = model.rsplit('/').next().unwrap_or_default();
    let suffix = regex::Regex::new(r"-(?:\d{4}-\d{2}-\d{2}|\d{8})$").unwrap();
    suffix.replace(model, "").into_owned()
}

pub fn validate(prices: PriceTable) -> Result<PriceTable, String> {
    let mut normalized = PriceTable::new();
    for (model, price) in prices {
        let name = normalize_model(&model);
        if name.is_empty() || name == "unknown" {
            return Err("Model name must not be empty or unknown.".into());
        }
        if [price.input, price.cached_input, price.output]
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(format!(
                "Invalid price for {model}: use finite, non-negative USD values."
            ));
        }
        if normalized.insert(name.clone(), price).is_some() {
            return Err(format!("Duplicate model after normalization: {name}"));
        }
    }
    Ok(normalized)
}

pub fn load(path: &Path) -> Result<PriceTable, String> {
    match fs::read_to_string(path) {
        Ok(contents) => validate(serde_json::from_str(&contents).map_err(|error| {
            format!("Invalid price configuration at {}: {error}", path.display())
        })?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(defaults()),
        Err(error) => Err(format!("Cannot read prices at {}: {error}", path.display())),
    }
}

fn unique_id() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

pub fn save(path: &Path, prices: PriceTable) -> Result<(), String> {
    let prices = validate(prices)?;
    let contents = serde_json::to_vec_pretty(&prices).map_err(|error| error.to_string())?;
    let parent = path.parent().ok_or("Invalid price configuration path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!("model-prices-{}.tmp", unique_id()));
    let result = (|| {
        fs::write(&temporary, contents).map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn price(input: f64) -> ModelPrice {
        ModelPrice {
            input,
            cached_input: 0.0,
            output: 2.0,
        }
    }

    #[test]
    fn validates_and_normalizes_models() {
        let table = validate(BTreeMap::from([(
            " OpenAI/NEW-model-2026-10-14 ".into(),
            price(1.0),
        )]))
        .unwrap();
        assert!(table.contains_key("new-model"));
        assert!(validate(BTreeMap::from([("unknown".into(), price(1.0))])).is_err());
        assert!(validate(BTreeMap::from([("new".into(), price(-1.0))])).is_err());
        assert!(validate(BTreeMap::from([("new".into(), price(f64::NAN))])).is_err());
        assert!(validate(BTreeMap::from([
            ("new".into(), price(1.0)),
            ("NEW".into(), price(2.0))
        ]))
        .is_err());
    }

    #[test]
    fn persists_edits_deletions_and_reports_corrupt_files() {
        let root = std::env::temp_dir().join(format!("usage-pricing-{}", unique_id()));
        let path = root.join("model-prices.json");
        assert!(load(&path).unwrap().contains_key("gpt-5.4"));
        save(&path, BTreeMap::from([("new-model".into(), price(0.0))])).unwrap();
        assert_eq!(load(&path).unwrap()["new-model"].input, 0.0);
        assert!(save(&path, BTreeMap::from([("new".into(), price(-1.0))])).is_err());
        assert!(load(&path).unwrap().contains_key("new-model"));
        save(&path, PriceTable::new()).unwrap();
        assert!(load(&path).unwrap().is_empty());
        fs::write(&path, "invalid json").unwrap();
        assert!(load(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
