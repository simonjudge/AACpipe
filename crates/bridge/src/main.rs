#![cfg_attr(windows, windows_subsystem = "windows")]

use std::env;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aacpipe_win32_native::{
    acquire_start_mutex, clipboard_text, default_pipe_name, default_publisher_mutex_name,
    default_start_mutex_name, pipe_transact, NativeError,
};
use clap::{error::ErrorKind, Parser};
use serde::{Deserialize, Serialize};

const EXIT_OTHER: i32 = 1;
const EXIT_ARGUMENTS: i32 = 2;
const EXIT_CLIPBOARD: i32 = 3;
const EXIT_PUBLISHER: i32 = 4;
const EXIT_PAYLOAD: i32 = 5;
const EXIT_REFUSED: i32 = 6;
const DEFAULT_TIMEOUT_MS: u32 = 1500;
const PUBLISHER_STARTUP_TIMEOUT_MS: u32 = 30_000;
const INITIAL_PIPE_PROBE_MS: u32 = 50;
const MAX_WORD_BYTES: usize = 256;
const MAX_SENTENCE_BYTES: usize = 64 * 1024;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Parser)]
#[command(name = "aacpipe-bridge", disable_help_subcommand = true)]
struct Cli {
    #[arg(long)]
    word: bool,
    #[arg(long)]
    sentence: bool,
    #[arg(long)]
    clear: bool,
    #[arg(long)]
    speak: bool,
    #[arg(long)]
    pair: bool,
    #[arg(long)]
    revoke: bool,
    #[arg(long)]
    status: bool,
    #[arg(long)]
    json: bool,
    #[arg(long)]
    text: Option<String>,
    #[arg(long, conflicts_with = "text")]
    text_stdin: bool,
    #[arg(long)]
    persistent: bool,
    #[arg(long)]
    ephemeral: bool,
    #[arg(long)]
    label: Option<String>,
    #[arg(long)]
    all: bool,
    #[arg(long, conflicts_with_all = ["hide", "preserve_window"])]
    show: bool,
    #[arg(long, conflicts_with = "preserve_window")]
    hide: bool,
    #[arg(long)]
    preserve_window: bool,
    #[arg(long)]
    no_autostart: bool,
    #[arg(long, default_value_t = DEFAULT_TIMEOUT_MS, value_parser = clap::value_parser!(u32).range(100..=30_000))]
    timeout: u32,
}

#[derive(Debug, PartialEq)]
enum Action {
    Word { speak: bool },
    Sentence { speak: bool },
    Clear,
    Speak,
    Pair { persistent: bool },
    Revoke,
    Status,
    Window,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum WindowRequest {
    Show,
    Hide,
}

impl WindowRequest {
    fn as_str(self) -> &'static str {
        match self {
            WindowRequest::Show => "show",
            WindowRequest::Hide => "hide",
        }
    }
}

#[derive(Debug)]
struct ValidatedCli {
    action: Action,
    text: Option<String>,
    text_stdin: bool,
    label: Option<String>,
    all: bool,
    window: Option<WindowRequest>,
    timeout_ms: u32,
    no_autostart: bool,
}

#[derive(Debug, Serialize)]
struct Request {
    v: u8,
    id: String,
    cmd: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    speak: Option<bool>,
    #[serde(rename = "channelType", skip_serializing_if = "Option::is_none")]
    channel_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    all: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    window: Option<&'static str>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum Response {
    Success {
        v: u8,
        id: String,
        ok: bool,
        state: String,
        revision: String,
        channels: u32,
        subscribers: u32,
    },
    Failure {
        v: u8,
        id: String,
        ok: bool,
        code: u8,
        error: String,
    },
}

fn validate_cli(cli: Cli) -> Result<ValidatedCli, String> {
    let content_actions =
        usize::from(cli.word) + usize::from(cli.sentence) + usize::from(cli.clear);
    let management_actions =
        usize::from(cli.pair) + usize::from(cli.revoke) + usize::from(cli.status);
    let speak_only = cli.speak && content_actions == 0 && management_actions == 0;
    let action_count = content_actions + management_actions + usize::from(speak_only);
    let explicit_window = if cli.show {
        Some(WindowRequest::Show)
    } else if cli.hide {
        Some(WindowRequest::Hide)
    } else {
        None
    };
    let window_only = action_count == 0 && explicit_window.is_some();

    if action_count != 1 && !window_only {
        return Err(
            "specify exactly one action (or only --show/--hide); --speak may only accompany --word or --sentence"
                .to_owned(),
        );
    }
    if cli.speak && cli.clear {
        return Err("--speak cannot accompany --clear".to_owned());
    }
    if cli.speak && management_actions > 0 {
        return Err("--speak cannot accompany a management command".to_owned());
    }
    if (cli.text.is_some() || cli.text_stdin) && !cli.word && !cli.sentence {
        return Err("--text and --text-stdin require --word or --sentence".to_owned());
    }
    if (cli.persistent || cli.ephemeral) && !cli.pair {
        return Err("--persistent and --ephemeral require --pair".to_owned());
    }
    if cli.label.is_some() && !cli.pair && !cli.revoke {
        return Err("--label requires --pair or --revoke".to_owned());
    }
    if cli.persistent && cli.ephemeral {
        return Err("--persistent and --ephemeral are mutually exclusive".to_owned());
    }
    if cli.all && !cli.revoke {
        return Err("--all requires --revoke".to_owned());
    }
    if cli.revoke && (cli.label.is_some() == cli.all) {
        return Err("--revoke requires exactly one of --label or --all".to_owned());
    }
    if let Some(label) = &cli.label {
        let trimmed = label.trim();
        if trimmed.is_empty() || trimmed.len() > 128 {
            return Err("--label must contain 1 to 128 UTF-8 bytes after trimming".to_owned());
        }
    }

    let action = if cli.word {
        Action::Word { speak: cli.speak }
    } else if cli.sentence {
        Action::Sentence { speak: cli.speak }
    } else if cli.clear {
        Action::Clear
    } else if speak_only {
        Action::Speak
    } else if cli.pair {
        Action::Pair {
            persistent: cli.persistent,
        }
    } else if cli.revoke {
        Action::Revoke
    } else if cli.status {
        Action::Status
    } else {
        Action::Window
    };
    // Content commands come from Grid, so keep the pairing window from covering it.
    let window = explicit_window.or(match action {
        _ if cli.preserve_window => None,
        Action::Word { .. } | Action::Sentence { .. } | Action::Clear | Action::Speak => {
            Some(WindowRequest::Hide)
        }
        _ => None,
    });

    Ok(ValidatedCli {
        action,
        text: cli.text,
        text_stdin: cli.text_stdin,
        label: cli.label.map(|label| label.trim().to_owned()),
        all: cli.all,
        window,
        timeout_ms: cli.timeout,
        no_autostart: cli.no_autostart,
    })
}

fn request_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let counter = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{timestamp:x}-{counter:x}", std::process::id())
}

fn build_request(
    command: ValidatedCli,
    read_clipboard: impl FnOnce() -> Result<String, NativeError>,
) -> Result<Request, (i32, String)> {
    let id = request_id();
    let mut request = Request {
        v: 1,
        id,
        cmd: "status",
        text: None,
        speak: None,
        channel_type: None,
        label: None,
        all: None,
        window: command.window.map(WindowRequest::as_str),
    };

    match command.action {
        Action::Word { speak } | Action::Sentence { speak } => {
            let is_word = matches!(command.action, Action::Word { .. });
            let text = match command.text {
                Some(text) => text,
                None => read_clipboard().map_err(|error| (EXIT_CLIPBOARD, error.to_string()))?,
            };
            let max_bytes = if is_word {
                MAX_WORD_BYTES
            } else {
                MAX_SENTENCE_BYTES
            };
            if text.is_empty() || text.len() > max_bytes {
                return Err((
                    EXIT_PAYLOAD,
                    format!(
                        "{} text must contain 1 to {max_bytes} UTF-8 bytes",
                        if is_word { "word" } else { "sentence" }
                    ),
                ));
            }
            request.cmd = if is_word { "word" } else { "sentence" };
            request.text = Some(text);
            request.speak = speak.then_some(true);
        }
        Action::Clear => request.cmd = "clear",
        Action::Speak => request.cmd = "speak",
        Action::Pair { persistent } => {
            request.cmd = "pair";
            request.channel_type = Some(if persistent {
                "persistent"
            } else {
                "ephemeral"
            });
            request.label = command.label;
        }
        Action::Revoke => {
            request.cmd = "revoke";
            request.label = command.label;
            request.all = command.all.then_some(true);
        }
        Action::Status | Action::Window => request.cmd = "status",
    }
    Ok(request)
}

fn read_text_input(mut input: impl Read) -> Result<String, (i32, String)> {
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take((MAX_SENTENCE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            (
                EXIT_PAYLOAD,
                format!("cannot read text from stdin: {error}"),
            )
        })?;
    if bytes.len() > MAX_SENTENCE_BYTES {
        return Err((
            EXIT_PAYLOAD,
            "stdin text exceeds 65536 UTF-8 bytes".to_owned(),
        ));
    }
    String::from_utf8(bytes).map_err(|error| {
        (
            EXIT_PAYLOAD,
            format!("stdin text is not valid UTF-8: {error}"),
        )
    })
}

fn publisher_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("AACPIPE_PUBLISHER_PATH") {
        return Ok(PathBuf::from(path));
    }
    let current =
        env::current_exe().map_err(|error| format!("cannot find bridge executable: {error}"))?;
    Ok(current
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("AACpipe.exe"))
}

fn publisher_args(hidden: bool) -> Result<Vec<OsString>, String> {
    let mut args = match env::var("AACPIPE_PUBLISHER_ARGS_JSON") {
        Ok(value) => serde_json::from_str::<Vec<String>>(&value)
            .map(|args| args.into_iter().map(OsString::from).collect())
            .map_err(|error| format!("AACPIPE_PUBLISHER_ARGS_JSON is invalid: {error}"))?,
        Err(env::VarError::NotPresent) => vec![OsString::from("--host")],
        Err(error) => return Err(format!("cannot read publisher arguments: {error}")),
    };
    if hidden {
        args.push(OsString::from("--hidden"));
    }
    Ok(args)
}

#[cfg(windows)]
fn start_publisher(hidden: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    let path = publisher_path()?;
    let mut command = Command::new(&path);
    command
        .args(publisher_args(hidden)?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("cannot start {}: {error}", path.display()))
}

fn transact_with_autostart(
    pipe_name: &str,
    request: &str,
    timeout_ms: u32,
    start_hidden: bool,
) -> Result<String, (i32, String)> {
    let started = Instant::now();
    if let Ok(response) = pipe_transact(pipe_name, request, timeout_ms.min(INITIAL_PIPE_PROBE_MS)) {
        return Ok(response);
    }

    let mutex_name = default_start_mutex_name().map_err(|error| (EXIT_OTHER, error.to_string()))?;
    let startup_timeout_ms = timeout_ms.max(PUBLISHER_STARTUP_TIMEOUT_MS);
    let mut mutex =
        acquire_start_mutex(&mutex_name).map_err(|error| (EXIT_OTHER, error.to_string()))?;
    if mutex.is_owner {
        let publisher_mutex_name =
            default_publisher_mutex_name().map_err(|error| (EXIT_OTHER, error.to_string()))?;
        let publisher_mutex = acquire_start_mutex(&publisher_mutex_name)
            .map_err(|error| (EXIT_OTHER, error.to_string()))?;
        if publisher_mutex.is_owner {
            drop(publisher_mutex);
            start_publisher(start_hidden).map_err(|error| (EXIT_PUBLISHER, error))?;
        }
    } else {
        let elapsed = started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32;
        let remaining = startup_timeout_ms.saturating_sub(elapsed);
        if remaining == 0
            || !mutex
                .wait(remaining)
                .map_err(|error| (EXIT_OTHER, error.to_string()))?
        {
            return Err((EXIT_PUBLISHER, "Publisher startup timed out".to_owned()));
        }
    }

    let elapsed = started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32;
    let remaining = startup_timeout_ms.saturating_sub(elapsed);
    if remaining == 0 {
        return Err((EXIT_PUBLISHER, "Publisher startup timed out".to_owned()));
    }
    pipe_transact(pipe_name, request, remaining)
        .map_err(|error| (EXIT_PUBLISHER, error.to_string()))
}

fn validate_response(raw: &str, request_id: &str) -> Result<Response, (i32, String)> {
    let response: Response = serde_json::from_str(raw).map_err(|error| {
        (
            EXIT_OTHER,
            format!("Publisher returned invalid JSON: {error}"),
        )
    })?;
    match &response {
        Response::Success { v, id, ok, .. } if *v == 1 && id == request_id && *ok => Ok(response),
        Response::Failure {
            v,
            id,
            ok,
            code,
            error,
        } if *v == 1 && id == request_id && !*ok => Err((
            EXIT_REFUSED,
            format!("Publisher refused command ({code}): {error}"),
        )),
        _ => Err((
            EXIT_OTHER,
            "Publisher response did not match the request".to_owned(),
        )),
    }
}

fn normalize_argument(argument: OsString) -> OsString {
    match argument.to_str() {
        Some("-show") => OsString::from("--show"),
        Some("-hide") => OsString::from("--hide"),
        _ => argument,
    }
}

fn run_from<I, T>(arguments: I) -> Result<Response, (i32, String)>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let arguments = arguments
        .into_iter()
        .map(|argument| normalize_argument(argument.into()));
    let cli = Cli::try_parse_from(arguments).map_err(|error| {
        let code = if error.kind() == ErrorKind::DisplayHelp
            || error.kind() == ErrorKind::DisplayVersion
        {
            0
        } else {
            EXIT_ARGUMENTS
        };
        (code, error.to_string())
    })?;
    let mut validated = validate_cli(cli).map_err(|error| (EXIT_ARGUMENTS, error))?;
    if validated.text_stdin {
        validated.text = Some(read_text_input(std::io::stdin().lock())?);
    }
    let timeout_ms = validated.timeout_ms;
    let no_autostart = validated.no_autostart;
    let start_hidden = validated.window == Some(WindowRequest::Hide);
    let request = build_request(validated, || clipboard_text(Duration::from_millis(500)))?;
    let request_id = request.id.clone();
    let request_json = serde_json::to_string(&request)
        .map_err(|error| (EXIT_OTHER, format!("cannot encode request: {error}")))?;
    if request_json.len() + 1 > 128 * 1024 {
        return Err((EXIT_PAYLOAD, "IPC request exceeds 128 KiB".to_owned()));
    }
    let pipe_name = default_pipe_name().map_err(|error| (EXIT_OTHER, error.to_string()))?;
    let raw = if no_autostart {
        pipe_transact(&pipe_name, &request_json, timeout_ms)
            .map_err(|error| (EXIT_PUBLISHER, error.to_string()))?
    } else {
        transact_with_autostart(&pipe_name, &request_json, timeout_ms, start_hidden)?
    };
    validate_response(&raw, &request_id)
}

fn main() {
    match run_from(env::args_os()) {
        Ok(response @ Response::Success { .. }) => {
            if env::args().any(|argument| argument == "--json") {
                match serde_json::to_string(&response) {
                    Ok(json) => println!("{json}"),
                    Err(error) => {
                        eprintln!("cannot encode Publisher response: {error}");
                        std::process::exit(EXIT_OTHER);
                    }
                }
            } else if env::args().any(|argument| argument == "--status") {
                if let Response::Success {
                    state,
                    revision,
                    channels,
                    subscribers,
                    ..
                } = response
                {
                    println!(
                        "AACpipe Publisher: state={state}, revision={revision}, channels={channels}, subscribers={subscribers}"
                    );
                }
            }
        }
        Ok(Response::Failure { .. }) => unreachable!("failures are converted to exit errors"),
        Err((code, message)) => {
            if code != 0 {
                eprintln!("{message}");
            } else {
                println!("{message}");
            }
            std::process::exit(code);
        }
    }
}

#[cfg(test)]
mod ipc_contract_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(arguments: &[&str]) -> Result<ValidatedCli, String> {
        Cli::try_parse_from(arguments)
            .map_err(|error| error.to_string())
            .and_then(validate_cli)
    }

    #[test]
    fn accepts_every_documented_command_shape() {
        assert_eq!(
            parse(&["bridge", "--word"]).unwrap().action,
            Action::Word { speak: false }
        );
        assert_eq!(
            parse(&["bridge", "--sentence", "--speak"]).unwrap().action,
            Action::Sentence { speak: true }
        );
        assert_eq!(parse(&["bridge", "--clear"]).unwrap().action, Action::Clear);
        assert_eq!(parse(&["bridge", "--speak"]).unwrap().action, Action::Speak);
        assert_eq!(
            parse(&["bridge", "--pair", "--persistent", "--label", "Mum"])
                .unwrap()
                .action,
            Action::Pair { persistent: true }
        );
        assert_eq!(
            parse(&["bridge", "--revoke", "--label", "Mum"])
                .unwrap()
                .action,
            Action::Revoke
        );
        assert_eq!(
            parse(&["bridge", "--status"]).unwrap().action,
            Action::Status
        );
    }

    #[test]
    fn rejects_conflicting_flags() {
        for arguments in [
            vec!["bridge"],
            vec!["bridge", "--word", "--sentence"],
            vec!["bridge", "--clear", "--speak"],
            vec!["bridge", "--pair", "--revoke", "--all"],
            vec!["bridge", "--pair", "--persistent", "--ephemeral"],
            vec!["bridge", "--revoke"],
            vec!["bridge", "--revoke", "--all", "--label", "Mum"],
            vec!["bridge", "--revoke", "--label", "   "],
            vec!["bridge", "--status", "--label", "Mum"],
            vec!["bridge", "--revoke", "--persistent", "--label", "Mum"],
            vec!["bridge", "--status", "--text", "hello"],
        ] {
            assert!(parse(&arguments).is_err(), "{arguments:?} should fail");
        }
    }

    #[test]
    fn window_requests_default_to_hide_for_content_and_accept_overrides() {
        for (arguments, expected) in [
            (vec!["bridge", "--word"], Some(WindowRequest::Hide)),
            (vec!["bridge", "--sentence"], Some(WindowRequest::Hide)),
            (vec!["bridge", "--clear"], Some(WindowRequest::Hide)),
            (vec!["bridge", "--speak"], Some(WindowRequest::Hide)),
            (
                vec!["bridge", "--sentence", "--show"],
                Some(WindowRequest::Show),
            ),
            (vec!["bridge", "--pair"], None),
            (
                vec!["bridge", "--pair", "--show"],
                Some(WindowRequest::Show),
            ),
            (
                vec!["bridge", "--revoke", "--all", "--hide"],
                Some(WindowRequest::Hide),
            ),
            (vec!["bridge", "--status"], None),
        ] {
            assert_eq!(parse(&arguments).unwrap().window, expected, "{arguments:?}");
        }
        let show_only = parse(&["bridge", "--show"]).unwrap();
        assert_eq!(show_only.action, Action::Window);
        assert_eq!(show_only.window, Some(WindowRequest::Show));
        let request = build_request(show_only, || -> Result<String, NativeError> {
            unreachable!("window-only requests do not read the clipboard")
        })
        .unwrap();
        assert_eq!(request.cmd, "status");
        assert_eq!(request.window, Some("show"));
        assert_eq!(
            parse(&["bridge", "--hide"]).unwrap().window,
            Some(WindowRequest::Hide)
        );
        assert!(parse(&["bridge", "--show", "--hide"]).is_err());
        assert!(parse(&["bridge", "--show", "--text", "x"]).is_err());
    }

    #[test]
    fn single_dash_window_switches_are_accepted() {
        assert_eq!(normalize_argument("-show".into()), OsString::from("--show"));
        assert_eq!(normalize_argument("-hide".into()), OsString::from("--hide"));
        assert_eq!(normalize_argument("-x".into()), OsString::from("-x"));
    }

    #[test]
    fn explicit_text_takes_precedence_over_clipboard() {
        let validated = parse(&["bridge", "--word", "--text", "hello"]).unwrap();
        let request = build_request(validated, || panic!("clipboard should not be read")).unwrap();
        assert_eq!(request.text.as_deref(), Some("hello"));
    }

    #[test]
    fn clipboard_is_used_when_text_is_absent() {
        let validated = parse(&["bridge", "--sentence"]).unwrap();
        let request = build_request(validated, || Ok("clipboard sentence".to_owned())).unwrap();
        assert_eq!(request.text.as_deref(), Some("clipboard sentence"));
    }

    #[test]
    fn stdin_is_explicit_bounded_utf8_and_preserves_text() {
        let text = "quotes: \"hello\"\n日本語\r\n";
        assert_eq!(read_text_input(text.as_bytes()).unwrap(), text);
        assert_eq!(read_text_input(&[0xff][..]).unwrap_err().0, EXIT_PAYLOAD);
        assert!(read_text_input(vec![b'x'; MAX_SENTENCE_BYTES].as_slice()).is_ok());
        assert_eq!(
            read_text_input(vec![b'x'; MAX_SENTENCE_BYTES + 1].as_slice())
                .unwrap_err()
                .0,
            EXIT_PAYLOAD
        );
        let mut validated = parse(&[
            "bridge",
            "--sentence",
            "--text-stdin",
            "--preserve-window",
            "--no-autostart",
        ])
        .unwrap();
        assert!(validated.text_stdin);
        assert!(validated.no_autostart);
        assert_eq!(validated.window, None);
        validated.text = Some(text.to_owned());
        let request = build_request(validated, || panic!("must not read clipboard")).unwrap();
        assert_eq!(request.text.as_deref(), Some(text));
        assert_eq!(request.window, None);
        for arguments in [
            vec!["bridge", "--sentence", "--text-stdin", "--text", "x"],
            vec!["bridge", "--clear", "--text-stdin"],
            vec!["bridge", "--sentence", "--show", "--preserve-window"],
            vec!["bridge", "--sentence", "--hide", "--preserve-window"],
        ] {
            assert!(parse(&arguments).is_err());
        }
    }

    #[test]
    fn payload_limits_map_to_exit_code_five() {
        let validated = parse(&["bridge", "--word", "--text", &"x".repeat(257)]).unwrap();
        let error = build_request(validated, || unreachable!()).unwrap_err();
        assert_eq!(error.0, EXIT_PAYLOAD);
    }

    #[test]
    fn response_validation_rejects_mismatched_ids_and_refusals() {
        assert_eq!(
            validate_response(
                r#"{"v":1,"id":"other","ok":true,"state":"IDLE","revision":"0","channels":0,"subscribers":0}"#,
                "expected"
            )
            .unwrap_err()
            .0,
            EXIT_OTHER
        );
        assert_eq!(
            validate_response(
                r#"{"v":1,"id":"expected","ok":false,"code":6,"error":"unknown channel"}"#,
                "expected"
            )
            .unwrap_err()
            .0,
            EXIT_REFUSED
        );
    }
}
