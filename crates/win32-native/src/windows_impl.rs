use std::collections::HashMap;
use std::ffi::c_void;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_MORE_DATA, ERROR_PIPE_CONNECTED,
    ERROR_PIPE_LISTENING, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, WAIT_ABANDONED, WAIT_OBJECT_0,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use windows::Win32::Security::{
    GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, SetNamedPipeHandleState,
    WaitNamedPipeW, NAMED_PIPE_MODE, PIPE_NOWAIT, PIPE_READMODE_MESSAGE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcess, OpenProcessToken, ReleaseMutex, WaitForSingleObject,
};

use crate::{NativeError, MAX_FRAME_BYTES};

const CF_UNICODETEXT_FORMAT: u32 = 13;
const SECURITY_DESCRIPTOR_REVISION_1: u32 = 1;
const MAX_CLIPBOARD_BYTES: usize = 64 * 1024;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error(context: &str) -> NativeError {
    NativeError::Message(format!(
        "{context}: {}",
        windows::core::Error::from_thread()
    ))
}

fn owned_handle(handle: HANDLE, context: &str) -> Result<OwnedHandle, NativeError> {
    if handle == INVALID_HANDLE_VALUE || handle.is_invalid() {
        Err(last_error(context))
    } else {
        Ok(unsafe { OwnedHandle::from_raw_handle(handle.0) })
    }
}

fn handle(value: &OwnedHandle) -> HANDLE {
    HANDLE(value.as_raw_handle())
}

fn current_user_sid() -> Result<String, NativeError> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|_| last_error("OpenProcessToken failed"))?;
        let token = owned_handle(token, "OpenProcessToken returned an invalid handle")?;

        let mut required = 0u32;
        let _ = GetTokenInformation(handle(&token), TokenUser, None, 0, &mut required);
        if required == 0 {
            return Err(last_error("GetTokenInformation size query failed"));
        }

        let mut buffer = vec![0u8; required as usize];
        GetTokenInformation(
            handle(&token),
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            required,
            &mut required,
        )
        .map_err(|_| last_error("GetTokenInformation failed"))?;
        let token_user = &*(buffer.as_ptr().cast::<TOKEN_USER>());

        let mut sid_string = PWSTR::null();
        ConvertSidToStringSidW(token_user.User.Sid, &mut sid_string)
            .map_err(|_| last_error("ConvertSidToStringSidW failed"))?;
        let sid = sid_string
            .to_string()
            .map_err(|error| NativeError::Message(error.to_string()))?;
        let _ = LocalFree(Some(HLOCAL(sid_string.0.cast())));
        Ok(sid)
    }
}

fn fnv1a64(value: &str) -> u64 {
    value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

pub fn default_pipe_name() -> Result<String, NativeError> {
    Ok(format!(
        r"\\.\pipe\aacpipe.v1.{:016x}",
        fnv1a64(&current_user_sid()?)
    ))
}

pub fn default_start_mutex_name() -> Result<String, NativeError> {
    Ok(format!(
        r"Local\AACpipe.Start.{:016x}",
        fnv1a64(&current_user_sid()?)
    ))
}

pub fn default_publisher_mutex_name() -> Result<String, NativeError> {
    Ok(format!(
        r"Local\AACpipe.Publisher.{:016x}",
        fnv1a64(&current_user_sid()?)
    ))
}

pub fn validate_pipe_name(name: &str) -> Result<(), NativeError> {
    if !name.starts_with(r"\\.\pipe\aacpipe.") || name.len() > 256 {
        return Err(NativeError::Message(
            "pipe name must use the local AACpipe namespace".to_owned(),
        ));
    }
    Ok(())
}

struct SecurityDescriptor {
    pointer: *mut c_void,
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.pointer)));
            }
        }
    }
}

fn security_attributes() -> Result<
    (
        windows::Win32::Security::SECURITY_ATTRIBUTES,
        SecurityDescriptor,
    ),
    NativeError,
> {
    let sid = current_user_sid()?;
    let sddl = wide(&format!("D:P(A;;GA;;;{sid})"));
    let mut descriptor = PSECURITY_DESCRIPTOR(null_mut());
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SECURITY_DESCRIPTOR_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(|_| last_error("security descriptor creation failed"))?;
    }
    let owner = SecurityDescriptor {
        pointer: descriptor.0,
    };
    let attributes = windows::Win32::Security::SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<windows::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    Ok((attributes, owner))
}

fn create_pipe(name: &str) -> Result<OwnedHandle, NativeError> {
    validate_pipe_name(name)?;
    let name = wide(name);
    let (attributes, _descriptor) = security_attributes()?;
    let raw = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            MAX_FRAME_BYTES as u32,
            MAX_FRAME_BYTES as u32,
            0,
            Some(&attributes),
        )
    };
    owned_handle(raw, "CreateNamedPipeW failed")
}

fn connect_pipe(pipe: &OwnedHandle, timeout_ms: u32) -> Result<(), NativeError> {
    let started = Instant::now();
    loop {
        let result = unsafe { ConnectNamedPipe(handle(pipe), None) };
        let error = unsafe { GetLastError() };
        if result.is_ok() || error == ERROR_PIPE_CONNECTED {
            let mode = NAMED_PIPE_MODE(PIPE_READMODE_MESSAGE.0 | PIPE_WAIT.0);
            unsafe {
                SetNamedPipeHandleState(handle(pipe), Some(&mode), None, None)
                    .map_err(|_| last_error("setting connected pipe to blocking mode failed"))?;
            }
            return Ok(());
        }
        if error != ERROR_PIPE_LISTENING {
            return Err(last_error("ConnectNamedPipe failed"));
        }
        if started.elapsed() >= Duration::from_millis(u64::from(timeout_ms)) {
            return Err(NativeError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn begin_listening(pipe: &OwnedHandle) -> Result<(), NativeError> {
    let result = unsafe { ConnectNamedPipe(handle(pipe), None) };
    let error = unsafe { GetLastError() };
    if result.is_ok() || error == ERROR_PIPE_CONNECTED || error == ERROR_PIPE_LISTENING {
        Ok(())
    } else {
        Err(last_error(
            "ConnectNamedPipe failed while preparing next instance",
        ))
    }
}

fn read_frame(pipe: &OwnedHandle) -> Result<String, NativeError> {
    let mut output = Vec::new();
    loop {
        let mut buffer = [0u8; 4096];
        let mut read = 0u32;
        let result = unsafe {
            windows::Win32::Storage::FileSystem::ReadFile(
                handle(pipe),
                Some(&mut buffer),
                Some(&mut read),
                None,
            )
        };
        if result.is_err() && unsafe { GetLastError() } != ERROR_MORE_DATA {
            return Err(last_error("ReadFile failed"));
        }
        output.extend_from_slice(&buffer[..read as usize]);
        if output.len() > MAX_FRAME_BYTES {
            return Err(NativeError::FrameTooLarge);
        }
        if let Some(newline) = output.iter().position(|byte| *byte == b'\n') {
            if output[newline + 1..]
                .iter()
                .any(|byte| !byte.is_ascii_whitespace())
            {
                return Err(NativeError::Message(
                    "only one request is permitted per connection".to_owned(),
                ));
            }
            output.truncate(newline);
            return String::from_utf8(output)
                .map_err(|_| NativeError::Message("request is not valid UTF-8".to_owned()));
        }
        if read == 0 {
            return Err(NativeError::IncompleteFrame);
        }
    }
}

fn write_frame(pipe: &OwnedHandle, value: &str) -> Result<(), NativeError> {
    let mut bytes = value.as_bytes().to_vec();
    if bytes.last() != Some(&b'\n') {
        bytes.push(b'\n');
    }
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(NativeError::FrameTooLarge);
    }
    let mut offset = 0usize;
    while offset < bytes.len() {
        let mut written = 0u32;
        unsafe {
            windows::Win32::Storage::FileSystem::WriteFile(
                handle(pipe),
                Some(&bytes[offset..]),
                Some(&mut written),
                None,
            )
        }
        .map_err(|_| last_error("WriteFile failed"))?;
        if written == 0 {
            return Err(NativeError::Message(
                "WriteFile made no progress".to_owned(),
            ));
        }
        offset += written as usize;
    }
    Ok(())
}

pub struct ReceivedRequest {
    pub connection_id: u32,
    pub payload: String,
}

pub struct PipeServerState {
    pipe_name: String,
    next_connection: AtomicU32,
    connections: Mutex<HashMap<u32, OwnedHandle>>,
    pending_pipe: Mutex<Option<OwnedHandle>>,
}

impl PipeServerState {
    pub fn new(pipe_name: String) -> Self {
        Self {
            pipe_name,
            next_connection: AtomicU32::new(1),
            connections: Mutex::new(HashMap::new()),
            pending_pipe: Mutex::new(None),
        }
    }

    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }

    pub fn receive(&self, timeout_ms: u32) -> Result<ReceivedRequest, NativeError> {
        let pipe = self
            .pending_pipe
            .lock()
            .map_err(|_| NativeError::Message("pending pipe registry poisoned".to_owned()))?
            .take()
            .map(Ok)
            .unwrap_or_else(|| create_pipe(&self.pipe_name))?;
        connect_pipe(&pipe, timeout_ms)?;
        let payload = read_frame(&pipe)?;
        let connection_id = self.next_connection.fetch_add(1, Ordering::Relaxed);
        self.connections
            .lock()
            .map_err(|_| NativeError::Message("connection registry poisoned".to_owned()))?
            .insert(connection_id, pipe);
        Ok(ReceivedRequest {
            connection_id,
            payload,
        })
    }

    pub fn respond(&self, connection_id: u32, response: &str) -> Result<(), NativeError> {
        let pipe = self
            .connections
            .lock()
            .map_err(|_| NativeError::Message("connection registry poisoned".to_owned()))?
            .remove(&connection_id)
            .ok_or_else(|| NativeError::Message("unknown pipe connection".to_owned()))?;
        let next_pipe = create_pipe(&self.pipe_name)?;
        begin_listening(&next_pipe)?;
        *self
            .pending_pipe
            .lock()
            .map_err(|_| NativeError::Message("pending pipe registry poisoned".to_owned()))? =
            Some(next_pipe);
        let result = write_frame(&pipe, response);
        unsafe {
            let _ = DisconnectNamedPipe(handle(&pipe));
        }
        result
    }
}

pub fn pipe_transact(name: &str, request: &str, timeout_ms: u32) -> Result<String, NativeError> {
    validate_pipe_name(name)?;
    let name_wide = wide(name);
    let started = Instant::now();
    loop {
        let remaining =
            Duration::from_millis(u64::from(timeout_ms)).saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(NativeError::Timeout);
        }
        let waited = unsafe {
            WaitNamedPipeW(
                PCWSTR(name_wide.as_ptr()),
                remaining.as_millis().min(50) as u32,
            )
        };
        if !waited.as_bool() {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let raw = unsafe {
            CreateFileW(
                PCWSTR(name_wide.as_ptr()),
                (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
                windows::Win32::Storage::FileSystem::FILE_SHARE_MODE(0),
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        };
        let Ok(raw) = raw else {
            continue;
        };
        match owned_handle(raw, "CreateFileW for named pipe failed") {
            Ok(pipe) => {
                let mode = NAMED_PIPE_MODE(PIPE_READMODE_MESSAGE.0);
                unsafe {
                    SetNamedPipeHandleState(handle(&pipe), Some(&mode), None, None)
                        .map_err(|_| last_error("SetNamedPipeHandleState failed"))?;
                }
                write_frame(&pipe, request)?;
                return read_frame(&pipe);
            }
            Err(_) => continue,
        }
    }
}

pub struct StartMutex {
    handle: OwnedHandle,
    pub is_owner: bool,
}

impl StartMutex {
    pub fn wait(&mut self, timeout_ms: u32) -> Result<bool, NativeError> {
        let result = unsafe { WaitForSingleObject(handle(&self.handle), timeout_ms) };
        self.is_owner = result == WAIT_OBJECT_0 || result == WAIT_ABANDONED;
        Ok(self.is_owner)
    }
}

impl Drop for StartMutex {
    fn drop(&mut self) {
        if self.is_owner {
            unsafe {
                let _ = ReleaseMutex(handle(&self.handle));
            }
        }
    }
}

pub fn acquire_start_mutex(name: &str) -> Result<StartMutex, NativeError> {
    let name = wide(name);
    let raw = unsafe { CreateMutexW(None, true, PCWSTR(name.as_ptr())) }
        .map_err(|_| last_error("CreateMutexW failed"))?;
    let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    Ok(StartMutex {
        handle: owned_handle(raw, "CreateMutexW returned invalid handle")?,
        is_owner: !already_exists,
    })
}

pub fn clipboard_text(retry_for: Duration) -> Result<String, NativeError> {
    open_clipboard_with_retry(retry_for, || unsafe { OpenClipboard(None) }.is_ok())?;

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
    let _guard = ClipboardGuard;

    require_unicode_clipboard_format(
        unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT_FORMAT) }.is_ok(),
    )?;
    let data = unsafe { GetClipboardData(CF_UNICODETEXT_FORMAT) }
        .map_err(|_| last_error("GetClipboardData failed"))?;
    let global = windows::Win32::Foundation::HGLOBAL(data.0);
    let size = unsafe { GlobalSize(global) };
    validate_clipboard_allocation_size(size)?;
    let pointer = unsafe { GlobalLock(global) };
    if pointer.is_null() {
        return Err(last_error("GlobalLock failed"));
    }
    struct GlobalGuard(windows::Win32::Foundation::HGLOBAL);
    impl Drop for GlobalGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = GlobalUnlock(self.0);
            }
        }
    }
    let _global = GlobalGuard(global);
    let units = unsafe { std::slice::from_raw_parts(pointer.cast::<u16>(), size / 2) };
    decode_clipboard_utf16(units, size)
}

fn open_clipboard_with_retry(
    retry_for: Duration,
    mut attempt: impl FnMut() -> bool,
) -> Result<(), NativeError> {
    let started = Instant::now();
    loop {
        if attempt() {
            return Ok(());
        }
        if started.elapsed() >= retry_for {
            return Err(NativeError::Message("clipboard is unavailable".to_owned()));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn require_unicode_clipboard_format(available: bool) -> Result<(), NativeError> {
    if available {
        Ok(())
    } else {
        Err(NativeError::Message(
            "clipboard does not contain Unicode text".to_owned(),
        ))
    }
}

fn validate_clipboard_allocation_size(size: usize) -> Result<(), NativeError> {
    if size == 0 || size > MAX_CLIPBOARD_BYTES {
        Err(NativeError::Message(
            "clipboard text is empty or exceeds 64 KiB".to_owned(),
        ))
    } else if !size.is_multiple_of(2) {
        Err(NativeError::Message(
            "clipboard Unicode allocation has an odd byte length".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn decode_clipboard_utf16(units: &[u16], allocation_size: usize) -> Result<String, NativeError> {
    validate_clipboard_allocation_size(allocation_size)?;
    if allocation_size / 2 > units.len() {
        return Err(NativeError::Message(
            "clipboard Unicode allocation is incomplete".to_owned(),
        ));
    }
    let end = units
        .iter()
        .take(allocation_size / 2)
        .position(|unit| *unit == 0)
        .unwrap_or(allocation_size / 2);
    let text = String::from_utf16(&units[..end])
        .map_err(|_| NativeError::Message("clipboard contains malformed UTF-16".to_owned()))?;
    normalize_clipboard_text(&text)
}

pub fn normalize_clipboard_text(value: &str) -> Result<String, NativeError> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let filtered: String = normalized
        .chars()
        .filter(|character| {
            *character == '\n'
                || *character == '\t'
                || (!character.is_control() && *character != '\u{7f}')
        })
        .collect();
    if filtered.is_empty() {
        Err(NativeError::Message("clipboard text is empty".to_owned()))
    } else {
        Ok(filtered)
    }
}

pub fn protect_data(plaintext: &[u8]) -> Result<Vec<u8>, NativeError> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| last_error("CryptProtectData failed"))?;
    }
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(protected)
}

pub fn unprotect_data(protected: &[u8]) -> Result<Vec<u8>, NativeError> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: protected.len() as u32,
        pbData: protected.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| last_error("CryptUnprotectData failed"))?;
    }
    let plaintext =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr::null_mut;
    use std::sync::Arc;
    use windows::Win32::Foundation::WIN32_ERROR;
    use windows::Win32::Security::{
        AclSizeInformation, GetAce, GetAclInformation, GetKernelObjectSecurity,
        GetSecurityDescriptorDacl, ACCESS_ALLOWED_ACE, ACL_SIZE_INFORMATION,
        DACL_SECURITY_INFORMATION,
    };
    use windows::Win32::Storage::FileSystem::{FILE_ALL_ACCESS, FILE_SHARE_MODE};
    use windows::Win32::System::Pipes::{GetNamedPipeInfo, NAMED_PIPE_MODE};

    #[test]
    fn pipe_and_mutex_names_are_stable_and_scoped() {
        let pipe = default_pipe_name().unwrap();
        let mutex = default_start_mutex_name().unwrap();
        let publisher_mutex = default_publisher_mutex_name().unwrap();
        assert!(pipe.starts_with(r"\\.\pipe\aacpipe.v1."));
        assert!(mutex.starts_with(r"Local\AACpipe.Start."));
        assert!(publisher_mutex.starts_with(r"Local\AACpipe.Publisher."));
        assert_eq!(pipe, default_pipe_name().unwrap());
    }

    #[test]
    fn clipboard_normalization_is_defensive() {
        assert_eq!(
            normalize_clipboard_text("hello\r\nworld\r\u{0007}!").unwrap(),
            "hello\nworld\n!"
        );
        assert!(normalize_clipboard_text("\u{0000}\u{0007}").is_err());
    }

    #[test]
    fn clipboard_validation_covers_adversarial_content() {
        assert!(require_unicode_clipboard_format(false).is_err());
        assert!(validate_clipboard_allocation_size(0).is_err());
        assert!(validate_clipboard_allocation_size(MAX_CLIPBOARD_BYTES + 2).is_err());
        assert!(validate_clipboard_allocation_size(3).is_err());
        assert!(decode_clipboard_utf16(&[0], 2).is_err());
        assert!(decode_clipboard_utf16(&[0xd800, 0], 4).is_err());
        assert!(decode_clipboard_utf16(&[b'A' as u16], 4).is_err());

        let mut units = "initial"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let snapshot = decode_clipboard_utf16(&units, units.len() * 2).unwrap();
        units.fill(b'X' as u16);
        assert_eq!(snapshot, "initial");
    }

    #[test]
    fn clipboard_retry_handles_locked_and_changing_availability() {
        let started = Instant::now();
        let result = open_clipboard_with_retry(Duration::from_millis(40), || false);
        assert!(matches!(
            result,
            Err(NativeError::Message(message)) if message == "clipboard is unavailable"
        ));
        assert!(started.elapsed() >= Duration::from_millis(40));

        let mut attempts = 0;
        open_clipboard_with_retry(Duration::from_secs(1), || {
            attempts += 1;
            attempts == 3
        })
        .unwrap();
        assert_eq!(attempts, 3);
    }

    #[test]
    fn dpapi_round_trip() {
        let secret = b"private channel secret";
        let protected = protect_data(secret).unwrap();
        assert_ne!(protected, secret);
        assert_eq!(unprotect_data(&protected).unwrap(), secret);
    }

    #[test]
    fn secure_pipe_round_trip() {
        let name = format!(r"\\.\pipe\aacpipe.test.{}", std::process::id());
        let server = Arc::new(PipeServerState::new(name.clone()));
        let server_task = {
            let server = server.clone();
            std::thread::spawn(move || {
                let request = server.receive(5000).unwrap();
                assert_eq!(request.payload, r#"{"test":true}"#);
                server
                    .respond(request.connection_id, r#"{"ok":true}"#)
                    .unwrap();
            })
        };
        let response = pipe_transact(&name, r#"{"test":true}"#, 5000).unwrap();
        assert_eq!(response, r#"{"ok":true}"#);
        server_task.join().unwrap();
    }

    #[test]
    fn secure_pipe_has_only_current_user_access_and_rejects_remote_namespace() {
        let name = format!(r"\\.\pipe\aacpipe.test.security.{}", std::process::id());
        let pipe = create_pipe(&name).unwrap();
        begin_listening(&pipe).unwrap();

        let mut flags = NAMED_PIPE_MODE(0);
        unsafe {
            GetNamedPipeInfo(handle(&pipe), Some(&mut flags), None, None, None).unwrap();
        }
        assert_eq!(flags.0 & PIPE_TYPE_MESSAGE.0, PIPE_TYPE_MESSAGE.0);

        let mut required = 0u32;
        let first = unsafe {
            GetKernelObjectSecurity(
                handle(&pipe),
                DACL_SECURITY_INFORMATION.0,
                None,
                0,
                &mut required,
            )
        };
        assert!(first.is_err());
        assert!(required > 0);

        let mut descriptor = vec![0u8; required as usize];
        unsafe {
            GetKernelObjectSecurity(
                handle(&pipe),
                DACL_SECURITY_INFORMATION.0,
                Some(PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast())),
                required,
                &mut required,
            )
            .unwrap();
        }

        let mut dacl_present = windows::core::BOOL::default();
        let mut dacl = null_mut();
        let mut dacl_defaulted = windows::core::BOOL::default();
        unsafe {
            GetSecurityDescriptorDacl(
                PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast()),
                &mut dacl_present,
                &mut dacl,
                &mut dacl_defaulted,
            )
            .unwrap();
        }
        assert!(dacl_present.as_bool());
        assert!(!dacl.is_null());

        let mut acl_info = ACL_SIZE_INFORMATION::default();
        unsafe {
            GetAclInformation(
                dacl,
                (&mut acl_info as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
            .unwrap();
        }
        assert_eq!(acl_info.AceCount, 1);

        let mut ace_pointer = null_mut();
        unsafe {
            GetAce(dacl, 0, &mut ace_pointer).unwrap();
        }
        let ace = unsafe { &*(ace_pointer.cast::<ACCESS_ALLOWED_ACE>()) };
        assert_eq!(ace.Header.AceType, 0);
        assert_eq!(ace.Mask, FILE_ALL_ACCESS.0);
        let ace_sid =
            windows::Win32::Security::PSID(std::ptr::addr_of!(ace.SidStart).cast_mut().cast());
        let mut ace_sid_string = PWSTR::null();
        unsafe {
            ConvertSidToStringSidW(ace_sid, &mut ace_sid_string).unwrap();
        }
        let ace_sid = unsafe { ace_sid_string.to_string().unwrap() };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(ace_sid_string.0.cast())));
        }
        assert_eq!(ace_sid, current_user_sid().unwrap());

        let remote_name = wide(&name.replacen(r"\\.\pipe\", r"\\localhost\pipe\", 1));
        let remote_open = unsafe {
            CreateFileW(
                PCWSTR(remote_name.as_ptr()),
                (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
                FILE_SHARE_MODE(0),
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        };
        assert!(remote_open.is_err());
        assert_ne!(unsafe { GetLastError() }, WIN32_ERROR(0));
    }

    #[test]
    fn secure_pipe_receive_honors_timeout() {
        let name = format!(r"\\.\pipe\aacpipe.test.timeout.{}", std::process::id());
        let server = PipeServerState::new(name);
        let started = Instant::now();
        assert!(matches!(server.receive(25), Err(NativeError::Timeout)));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn only_one_start_mutex_owner_is_created() {
        let name = format!(r"Local\AACpipe.Test.Start.{}", std::process::id());
        let first = acquire_start_mutex(&name).unwrap();
        let second = acquire_start_mutex(&name).unwrap();
        assert!(first.is_owner);
        assert!(!second.is_owner);
    }
}
