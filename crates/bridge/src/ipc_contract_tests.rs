use serde_json::{Map, Value};

const FIXTURES: &str = include_str!("../../../packages/test-vectors/fixtures/ipc-v1.json");
const MAX_UNSIGNED_64: u128 = 18_446_744_073_709_551_615;

fn materialize(value: Value) -> Value {
    match value {
        Value::Array(entries) => Value::Array(entries.into_iter().map(materialize).collect()),
        Value::Object(object)
            if object.len() == 2
                && object.contains_key("$repeat")
                && object.contains_key("count") =>
        {
            let repeated = object.get("$repeat").and_then(Value::as_str);
            let count = object
                .get("count")
                .and_then(Value::as_u64)
                .filter(|count| *count <= 100_000);
            match (repeated, count) {
                (Some(repeated), Some(count)) => Value::String(repeated.repeat(count as usize)),
                _ => Value::Object(
                    object
                        .into_iter()
                        .map(|(key, value)| (key, materialize(value)))
                        .collect(),
                ),
            }
        }
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, materialize(value)))
                .collect(),
        ),
        primitive => primitive,
    }
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn valid_request_id(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
}

fn valid_channel_id(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|id| id.len() == 17 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

fn optional_boolean(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_boolean)
}

fn integer_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| {
        value.as_f64().and_then(|number| {
            if number.is_finite()
                && number >= 0.0
                && number <= u64::MAX as f64
                && number.fract() == 0.0
            {
                Some(number as u64)
            } else {
                None
            }
        })
    })
}

fn valid_request(value: &Value) -> bool {
    let Some(request) = object(value) else {
        return false;
    };
    if integer_u64(request.get("v")) != Some(1) || !valid_request_id(request.get("id")) {
        return false;
    }

    match request.get("cmd").and_then(Value::as_str) {
        Some("word") => {
            request
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.len() <= 256)
                && optional_boolean(request.get("speak"))
        }
        Some("sentence") => {
            request
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.len() <= 65_536)
                && optional_boolean(request.get("speak"))
        }
        Some("clear" | "speak" | "status") => true,
        Some("pair") => {
            request.get("channelType").is_none_or(|channel_type| {
                matches!(channel_type.as_str(), Some("persistent" | "ephemeral"))
            }) && request.get("label").is_none_or(|label| {
                label.as_str().is_some_and(|label| {
                    let trimmed = label.trim();
                    !trimmed.is_empty() && trimmed.len() <= 128
                })
            })
        }
        Some("revoke") => {
            let channel_present = request.contains_key("channelId");
            let all = request.get("all").and_then(Value::as_bool) == Some(true);
            (channel_present ^ all)
                && (!channel_present || valid_channel_id(request.get("channelId")))
        }
        _ => false,
    }
}

fn canonical_revision(value: Option<&Value>) -> bool {
    let Some(value) = value.and_then(Value::as_str) else {
        return false;
    };
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    value
        .parse::<u128>()
        .is_ok_and(|revision| revision <= MAX_UNSIGNED_64)
}

fn nonnegative_integer(value: Option<&Value>) -> bool {
    integer_u64(value).is_some_and(|number| number <= 1024)
}

fn valid_response(value: &Value) -> bool {
    let Some(response) = object(value) else {
        return false;
    };
    if integer_u64(response.get("v")) != Some(1) || !valid_request_id(response.get("id")) {
        return false;
    }

    match response.get("ok").and_then(Value::as_bool) {
        Some(true) => {
            matches!(
                response.get("state").and_then(Value::as_str),
                Some("IDLE" | "COMPOSING" | "SPEAKING")
            ) && canonical_revision(response.get("revision"))
                && nonnegative_integer(response.get("channels"))
                && nonnegative_integer(response.get("subscribers"))
        }
        Some(false) => {
            response
                .get("code")
                .and_then(|value| integer_u64(Some(value)))
                .is_some_and(|code| (1..=255).contains(&code))
                && response
                    .get("error")
                    .and_then(Value::as_str)
                    .is_some_and(|error| !error.is_empty() && error.len() <= 256)
        }
        None => false,
    }
}

fn assert_cases(root: &Value, group: &str, expected: bool, validate: fn(&Value) -> bool) {
    let cases = root[group]
        .as_array()
        .expect("fixture group must be an array");
    for test_case in cases {
        let name = test_case["name"]
            .as_str()
            .expect("fixture case must have a name");
        let input = materialize(test_case["input"].clone());
        assert_eq!(
            validate(&input),
            expected,
            "fixture {group}/{name} produced an unexpected result"
        );
    }
}

fn normalize_request(value: &Value) -> Option<Value> {
    if !valid_request(value) {
        return None;
    }
    let mut normalized = value.as_object()?.clone();
    normalized.insert(
        "v".to_owned(),
        Value::from(integer_u64(normalized.get("v"))?),
    );
    if normalized.get("cmd").and_then(Value::as_str) == Some("pair") {
        normalized
            .entry("channelType")
            .or_insert_with(|| Value::String("ephemeral".to_owned()));
        if let Some(Value::String(label)) = normalized.get_mut("label") {
            *label = label.trim().to_owned();
        }
    }
    Some(Value::Object(normalized))
}

fn assert_valid_cases(root: &Value, group: &str, normalize: fn(&Value) -> Option<Value>) {
    let cases = root[group]
        .as_array()
        .expect("fixture group must be an array");
    for test_case in cases {
        let name = test_case["name"]
            .as_str()
            .expect("fixture case must have a name");
        let input = materialize(test_case["input"].clone());
        let expected = materialize(
            test_case
                .get("expected")
                .cloned()
                .unwrap_or_else(|| test_case["input"].clone()),
        );
        assert_eq!(
            normalize(&input),
            Some(expected),
            "fixture {group}/{name} normalized unexpectedly"
        );
    }
}

fn normalize_response(value: &Value) -> Option<Value> {
    if !valid_response(value) {
        return None;
    }
    let mut normalized = value.as_object()?.clone();
    normalized.insert(
        "v".to_owned(),
        Value::from(integer_u64(normalized.get("v"))?),
    );
    if normalized.get("ok").and_then(Value::as_bool) == Some(true) {
        for field in ["channels", "subscribers"] {
            normalized.insert(
                field.to_owned(),
                Value::from(integer_u64(normalized.get(field))?),
            );
        }
    } else {
        normalized.insert(
            "code".to_owned(),
            Value::from(integer_u64(normalized.get("code"))?),
        );
    }
    Some(Value::Object(normalized))
}

#[test]
fn rust_agrees_with_all_ipc_contract_fixtures() {
    let root: Value = serde_json::from_str(FIXTURES).expect("fixture JSON must parse");
    assert_eq!(integer_u64(root.get("fixtureVersion")), Some(1));
    assert_valid_cases(&root, "validRequests", normalize_request);
    assert_cases(&root, "invalidRequests", false, valid_request);
    assert_valid_cases(&root, "validResponses", normalize_response);
    assert_cases(&root, "invalidResponses", false, valid_response);
}
