use napi::bindgen_prelude::{Buffer, Error as NapiError, Result as NapiResult, Status};
use napi_derive::napi;
use thiserror::Error;
use zeroize::Zeroize;

#[cfg(windows)]
mod windows_impl;

const MAX_FRAME_BYTES: usize = 128 * 1024;

#[derive(Debug, Error)]
pub enum NativeError {
    #[error("{0}")]
    Message(String),
    #[error("operation timed out")]
    Timeout,
    #[error("frame exceeds the 131072-byte limit")]
    FrameTooLarge,
    #[error("connection was closed before a newline-terminated frame was received")]
    IncompleteFrame,
}

impl From<NativeError> for NapiError {
    fn from(value: NativeError) -> Self {
        NapiError::new(Status::GenericFailure, value.to_string())
    }
}

#[napi(object)]
pub struct PipeRequest {
    pub connection_id: u32,
    pub payload: String,
}

#[napi]
pub struct SecurePipeServer {
    #[cfg(windows)]
    inner: std::sync::Arc<windows_impl::PipeServerState>,
}

#[napi]
pub struct PublisherInstanceLock {
    #[cfg(windows)]
    inner: Option<windows_impl::StartMutex>,
    error: Option<String>,
}

#[napi]
impl PublisherInstanceLock {
    #[napi(constructor)]
    pub fn new(name: String) -> Self {
        #[cfg(windows)]
        {
            match windows_impl::acquire_start_mutex(&name) {
                Ok(inner) => Self {
                    inner: Some(inner),
                    error: None,
                },
                Err(error) => Self {
                    inner: None,
                    error: Some(error.to_string()),
                },
            }
        }
        #[cfg(not(windows))]
        {
            let _ = name;
            Self {
                error: Some("AACpipe native integration requires Windows".to_owned()),
            }
        }
    }

    #[napi(getter)]
    pub fn is_owner(&self) -> NapiResult<bool> {
        if let Some(error) = &self.error {
            return Err(NapiError::new(Status::GenericFailure, error.clone()));
        }
        #[cfg(windows)]
        {
            Ok(self.inner.as_ref().is_some_and(|mutex| mutex.is_owner))
        }
        #[cfg(not(windows))]
        {
            Ok(false)
        }
    }
}

#[napi]
impl SecurePipeServer {
    #[napi(constructor)]
    pub fn new(pipe_name: String) -> Self {
        #[cfg(windows)]
        {
            Self {
                inner: std::sync::Arc::new(windows_impl::PipeServerState::new(pipe_name)),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = pipe_name;
            Self {}
        }
    }

    #[napi]
    pub async fn receive(&self, timeout_ms: u32) -> NapiResult<PipeRequest> {
        #[cfg(windows)]
        {
            let state = self.inner.clone();
            let received = napi::tokio::task::spawn_blocking(move || state.receive(timeout_ms))
                .await
                .map_err(|error| NapiError::new(Status::GenericFailure, error.to_string()))??;
            Ok(PipeRequest {
                connection_id: received.connection_id,
                payload: received.payload,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = timeout_ms;
            Err(NapiError::new(
                Status::GenericFailure,
                "AACpipe native integration requires Windows",
            ))
        }
    }

    #[napi]
    pub async fn respond(&self, connection_id: u32, response: String) -> NapiResult<()> {
        #[cfg(windows)]
        {
            let state = self.inner.clone();
            napi::tokio::task::spawn_blocking(move || state.respond(connection_id, &response))
                .await
                .map_err(|error| NapiError::new(Status::GenericFailure, error.to_string()))??;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = (connection_id, response);
            Err(NapiError::new(
                Status::GenericFailure,
                "AACpipe native integration requires Windows",
            ))
        }
    }

    #[napi(getter)]
    pub fn pipe_name(&self) -> NapiResult<String> {
        #[cfg(windows)]
        {
            Ok(self.inner.pipe_name().to_owned())
        }
        #[cfg(not(windows))]
        {
            Err(NapiError::new(
                Status::GenericFailure,
                "AACpipe native integration requires Windows",
            ))
        }
    }
}

#[napi]
pub fn default_pipe_name() -> NapiResult<String> {
    #[cfg(windows)]
    {
        windows_impl::default_pipe_name().map_err(Into::into)
    }
    #[cfg(not(windows))]
    {
        Err(NapiError::new(
            Status::GenericFailure,
            "AACpipe native integration requires Windows",
        ))
    }
}

#[napi(js_name = "defaultPublisherMutexName")]
pub fn default_publisher_mutex_name_napi() -> NapiResult<String> {
    #[cfg(windows)]
    {
        windows_impl::default_publisher_mutex_name().map_err(Into::into)
    }
    #[cfg(not(windows))]
    {
        Err(NapiError::new(
            Status::GenericFailure,
            "AACpipe native integration requires Windows",
        ))
    }
}

#[napi]
pub fn protect_data(mut plaintext: Buffer) -> NapiResult<Buffer> {
    #[cfg(windows)]
    {
        let protected = windows_impl::protect_data(&plaintext)?;
        plaintext.as_mut().zeroize();
        Ok(protected.into())
    }
    #[cfg(not(windows))]
    {
        plaintext.as_mut().zeroize();
        Err(NapiError::new(
            Status::GenericFailure,
            "AACpipe native integration requires Windows",
        ))
    }
}

#[napi]
pub fn unprotect_data(protected: Buffer) -> NapiResult<Buffer> {
    #[cfg(windows)]
    {
        windows_impl::unprotect_data(&protected)
            .map(Buffer::from)
            .map_err(Into::into)
    }
    #[cfg(not(windows))]
    {
        let _ = protected;
        Err(NapiError::new(
            Status::GenericFailure,
            "AACpipe native integration requires Windows",
        ))
    }
}

#[cfg(windows)]
pub use windows_impl::{
    acquire_start_mutex, clipboard_text, default_publisher_mutex_name, default_start_mutex_name,
    pipe_transact,
};
