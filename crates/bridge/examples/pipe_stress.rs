use std::env;
use std::time::{Duration, Instant};

use aacpipe_win32_native::{default_pipe_name, pipe_transact};
use serde::Deserialize;

#[derive(Deserialize)]
struct Response {
    id: String,
    ok: bool,
}

fn main() {
    let count = env::args()
        .nth(1)
        .map(|value| value.parse::<u32>().expect("count must be an integer"))
        .unwrap_or(10_000);
    let pipe_name = default_pipe_name().expect("cannot determine pipe name");
    let started = Instant::now();

    for index in 0..count {
        let id = format!("stress-{index}");
        let request = format!(r#"{{"v":1,"id":"{id}","cmd":"status"}}"#);
        let raw = pipe_transact(&pipe_name, &request, 1_500).expect("pipe transaction failed");
        let response: Response = serde_json::from_str(&raw).expect("invalid response JSON");
        assert!(response.ok, "Publisher rejected transaction {index}");
        assert_eq!(
            response.id, id,
            "response ID mismatch at transaction {index}"
        );
    }

    let elapsed = started.elapsed();
    let average = elapsed / count;
    println!(
        "Delivered {count} sequential commands in {:.3}s (average {}).",
        elapsed.as_secs_f64(),
        format_duration(average)
    );
}

fn format_duration(value: Duration) -> String {
    if value.as_micros() < 1_000 {
        format!("{} us", value.as_micros())
    } else {
        format!("{:.3} ms", value.as_secs_f64() * 1_000.0)
    }
}
