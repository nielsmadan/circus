use circus_lib::contract::{DecideRequest, DecisionAction, TailsRequest};
use circus_lib::process::SystemRunner;
use circus_lib::rl::RlClient;
use serde_json::Value;

fn sandbox_client() -> (RlClient<SystemRunner>, String) {
    let rl = std::env::var("CIRCUS_RL").expect("CIRCUS_RL must be set; run `just smoke-sandbox`");
    let command = shlex::split(&rl).expect("CIRCUS_RL must be shell words");
    let world = std::env::var("CIRCUS_WORLD_ROOT")
        .ok()
        .filter(|w| !w.is_empty())
        .expect("CIRCUS_WORLD_ROOT must be set; run `just smoke-sandbox`");
    let client = RlClient::new(
        SystemRunner,
        command,
        std::env::var("PATH").ok(),
        "rl not found".to_string(),
    );
    (client, world)
}

fn json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).expect("valid JSON")
}

fn sessions(list: &Value) -> Vec<Value> {
    list["sessions"].as_array().expect("sessions array").clone()
}

fn text(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
        .to_string()
}

#[test]
#[ignore = "needs the synthetic world; run by `just smoke-sandbox`"]
fn rl_gui_contract_against_the_sandbox_world() {
    let (rl, world) = sandbox_client();

    let first = json(&rl.list().expect("first list"));
    let registry = text(&first, "registry");
    assert!(
        registry.starts_with(&format!("{world}/")),
        "registry {registry} is outside the world {world}; refusing to write"
    );

    let scan = json(&rl.scan().expect("scan"));
    assert_eq!(scan["kind"], "scan");

    let rows = sessions(&json(&rl.list().expect("list after scan")));
    assert!(!rows.is_empty(), "the world has sessions");

    let pair: Vec<&Value> = rows.iter().take(2).collect();
    let ids: Vec<String> = pair.iter().map(|row| text(row, "id")).collect();
    let tails = json(
        &rl.tails(&TailsRequest {
            ids: ids.clone(),
            max_chars: 50_000,
        })
        .expect("tails"),
    );
    assert_eq!(tails["kind"], "tails");
    let items = tails["items"].as_array().expect("items");
    assert_eq!(
        items
            .iter()
            .map(|item| text(item, "id"))
            .collect::<Vec<_>>(),
        ids
    );
    for (item, row) in items.iter().zip(&pair) {
        assert_eq!(item["unavailable"], Value::Null, "{item}");
        assert_eq!(item["mtime"], row["mtime"]);
    }

    let idle: Vec<&Value> = rows
        .iter()
        .filter(|row| row["running"] == Value::Bool(false))
        .collect();
    let target = idle.first().expect("a non-running row");
    let id = text(target, "id");
    let mtime = text(target, "mtime");

    let archive = json(
        &rl.decide(&DecideRequest {
            action: DecisionAction::Archive,
            id: id.clone(),
            mtime: mtime.clone(),
            fingerprint: None,
            until: None,
        })
        .expect("archive outcome"),
    );
    assert_eq!(archive["status"], "refused", "{archive}");
    assert_eq!(
        archive["reason"],
        "changed since you looked: no fingerprint, rescan"
    );

    let keep_going = json(
        &rl.decide(&DecideRequest {
            action: DecisionAction::KeepGoing,
            id: id.clone(),
            mtime,
            fingerprint: None,
            until: None,
        })
        .expect("keep_going outcome"),
    );
    assert_eq!(keep_going["status"], "ok", "{keep_going}");

    let after = sessions(&json(&rl.list().expect("list after keep_going")));
    assert_eq!(after.len(), rows.len() - 1);
    assert!(
        after
            .iter()
            .all(|row| row["id"] != Value::String(id.clone()))
    );
}
