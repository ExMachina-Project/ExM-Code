use axum::{
    extract::{Path, Query, Request, State},
    http::{header, HeaderValue, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        Response,
    },
    routing::{get, post, put},
    Json, Router,
};
use exm_code_runtime::{AgentRuntime, ManualEdit, SaveSettings, SessionUpdate};
use futures_util::stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    convert::Infallible,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tower_http::cors::{AllowOrigin, CorsLayer};

type ApiResult = Result<Json<Value>, (StatusCode, String)>;

#[derive(Clone)]
struct AppState {
    runtime: Arc<AgentRuntime>,
    security: Arc<SecurityConfig>,
}

struct SecurityConfig {
    token: Option<String>,
    origins: HashSet<String>,
}

impl SecurityConfig {
    fn new(listen: IpAddr, token: Option<String>, origins: Vec<String>) -> anyhow::Result<Self> {
        if !listen.is_loopback() {
            anyhow::ensure!(token.is_some(), "Remote binds require EXM_CODE_AUTH_TOKEN.");
            anyhow::ensure!(
                !origins.is_empty(),
                "Remote binds require at least one --allowed-origin."
            );
        }
        if let Some(token) = &token {
            anyhow::ensure!(
                token.len() >= 32
                    && token.len() <= 8192
                    && token.bytes().all(|b| b.is_ascii_graphic()),
                "Access tokens must contain 32–8192 printable ASCII characters without spaces."
            );
        }
        let origins = origins
            .into_iter()
            .map(|origin| {
                let uri: Uri = origin.parse()?;
                anyhow::ensure!(
                    !origin.contains(['#', '?', '@'])
                        && matches!(uri.scheme_str(), Some("http" | "https" | "tauri"))
                        && uri.authority().is_some()
                        && matches!(uri.path(), "" | "/"),
                    "Invalid allowed origin: use scheme + host only."
                );
                if uri.scheme_str() == Some("tauri") {
                    anyhow::ensure!(
                        uri.authority().unwrap().as_str() == "localhost",
                        "Tauri origins must be tauri://localhost."
                    );
                }
                Ok(format!(
                    "{}://{}",
                    uri.scheme_str().unwrap(),
                    uri.authority().unwrap()
                ))
            })
            .collect::<anyhow::Result<HashSet<_>>>()?;
        Ok(Self { token, origins })
    }
}

fn loopback_authority(value: &str) -> bool {
    value
        .parse::<axum::http::uri::Authority>()
        .is_ok_and(|a| matches!(a.host(), "127.0.0.1" | "localhost" | "[::1]"))
}

async fn access_control(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, (StatusCode, String)> {
    let headers = request.headers();
    if let Some(token) = &state.security.token {
        let is_health = request.method() == Method::GET && request.uri().path() == "/api/health";
        let supplied = headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .unwrap_or("");
        if !is_health && !bool::from(supplied.as_bytes().ct_eq(token.as_bytes())) {
            return Err((
                StatusCode::UNAUTHORIZED,
                "A valid bearer token is required.".into(),
            ));
        }
        if let Some(origin) = headers.get(header::ORIGIN) {
            if !origin
                .to_str()
                .is_ok_and(|origin| state.security.origins.contains(origin))
            {
                return Err((
                    StatusCode::FORBIDDEN,
                    "This web origin is not allowed.".into(),
                ));
            }
        }
    } else {
        let host = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if !loopback_authority(host) {
            return Err((
                StatusCode::FORBIDDEN,
                "Only loopback hosts are allowed.".into(),
            ));
        }
        if let Some(origin) = headers.get(header::ORIGIN) {
            let allowed = origin
                .to_str()
                .ok()
                .and_then(|s| s.parse::<Uri>().ok())
                .is_some_and(|uri| {
                    matches!(uri.scheme_str(), Some("http" | "https"))
                        && uri
                            .authority()
                            .is_some_and(|a| loopback_authority(a.as_str()))
                });
            if !allowed {
                return Err((
                    StatusCode::FORBIDDEN,
                    "Foreign origins cannot access the local workspace.".into(),
                ));
            }
        }
        if headers
            .get("sec-fetch-site")
            .is_some_and(|h| h == "cross-site")
        {
            return Err((
                StatusCode::FORBIDDEN,
                "Cross-site requests are not allowed.".into(),
            ));
        }
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

fn api_error(error: String) -> (StatusCode, String) {
    let status = if error.ends_with("not found") {
        StatusCode::NOT_FOUND
    } else if error.contains("already")
        || error.contains("Stop ")
        || error.contains("changed since")
        || error.contains("archived session")
    {
        StatusCode::CONFLICT
    } else if error.contains("concurrently") {
        StatusCode::TOO_MANY_REQUESTS
    } else if error.contains("Configure ") {
        StatusCode::PRECONDITION_FAILED
    } else {
        StatusCode::BAD_REQUEST
    };
    (status, error)
}

pub async fn serve(
    root: PathBuf,
    listen: IpAddr,
    port: u16,
    token: Option<String>,
    origins: Vec<String>,
) -> anyhow::Result<()> {
    let security = Arc::new(SecurityConfig::new(listen, token, origins)?);
    let root = root.canonicalize()?;
    let data = std::env::var_os("EXM_CODE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(".exm-code"));
    if data.exists() {
        anyhow::ensure!(
            !data.symlink_metadata()?.file_type().is_symlink(),
            "State directory must not be a symbolic link"
        );
    }
    std::fs::create_dir_all(&data)?;
    let data = data.canonicalize()?;
    anyhow::ensure!(
        !data.starts_with(&root) || data == root.join(".exm-code"),
        "State directory must be outside the project or its .exm-code directory"
    );
    let runtime = Arc::new(
        AgentRuntime::for_workspace(data, root.clone())
            .map_err(|e| anyhow::anyhow!(e.to_string()))?,
    );
    let router = app_router(AppState { runtime, security });
    let listener = tokio::net::TcpListener::bind(SocketAddr::new(listen, port)).await?;
    eprintln!(
        "ExM Code API · workspace {} · http://{}",
        root.display(),
        listener.local_addr()?
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

fn app_router(state: AppState) -> Router {
    let cors_origins = state
        .security
        .origins
        .iter()
        .map(|s| s.parse::<HeaderValue>().unwrap())
        .collect::<Vec<_>>();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(cors_origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({"ok":true,"name":"ExM Code"})) }),
        )
        .route("/api/settings", get(settings).put(save_settings))
        .route("/api/workspace", get(workspace))
        .route("/api/files", get(list_files))
        .route("/api/files/search", get(search_files))
        .route("/api/files/content-search", get(search_content))
        .route("/api/file", get(read_file))
        .route("/api/files/apply", post(apply))
        .route("/api/proposals/dismiss", post(dismiss))
        .route("/api/proposals/manual", post(stage_edit))
        .route("/api/sessions", get(sessions).post(create_session))
        .route(
            "/api/sessions/:id",
            put(update_session).delete(delete_session),
        )
        .route("/api/sessions/:id/messages", get(messages))
        .route("/api/sessions/:id/export", get(export_session))
        .route("/api/tasks", get(tasks))
        .route("/api/tasks/:id/cancel", post(cancel))
        .route("/api/chat", post(chat))
        .route("/api/chat/stream", post(chat_stream))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            access_control,
        ))
        .layer(cors)
        .with_state(state)
}

#[derive(Deserialize, Default)]
struct FileQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    query: String,
}
#[derive(Deserialize)]
struct NewSession {
    mode: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposalInput {
    proposal_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatInput {
    #[serde(default = "new_request_id")]
    request_id: String,
    session_id: String,
    mode: String,
    message: String,
    context_path: Option<String>,
}
fn new_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

async fn settings(State(s): State<AppState>) -> ApiResult {
    s.runtime.get_settings().map(Json).map_err(api_error)
}
async fn save_settings(State(s): State<AppState>, Json(input): Json<SaveSettings>) -> ApiResult {
    s.runtime.save_settings(input).map(Json).map_err(api_error)
}
async fn workspace(State(s): State<AppState>) -> ApiResult {
    s.runtime.workspace_info().map(Json).map_err(api_error)
}
async fn list_files(State(s): State<AppState>, Query(q): Query<FileQuery>) -> ApiResult {
    s.runtime.list_files(q.path).map(Json).map_err(api_error)
}
async fn search_files(State(s): State<AppState>, Query(q): Query<FileQuery>) -> ApiResult {
    s.runtime.search_files(q.query).map(Json).map_err(api_error)
}
async fn search_content(State(s): State<AppState>, Query(q): Query<FileQuery>) -> ApiResult {
    s.runtime
        .search_content(q.query)
        .map(Json)
        .map_err(api_error)
}
async fn read_file(State(s): State<AppState>, Query(q): Query<FileQuery>) -> ApiResult {
    s.runtime.read_file(q.path).map(Json).map_err(api_error)
}
async fn sessions(State(s): State<AppState>) -> ApiResult {
    s.runtime.list_sessions().map(Json).map_err(api_error)
}
async fn create_session(State(s): State<AppState>, Json(input): Json<NewSession>) -> ApiResult {
    s.runtime
        .create_session(input.mode.unwrap_or_else(|| "code".into()))
        .map(Json)
        .map_err(api_error)
}
async fn update_session(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<SessionUpdate>,
) -> ApiResult {
    s.runtime
        .update_session(id, input)
        .map(Json)
        .map_err(api_error)
}
async fn delete_session(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult {
    s.runtime.delete_session(id).map(Json).map_err(api_error)
}
async fn messages(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult {
    s.runtime.list_messages(id).map(Json).map_err(api_error)
}
async fn export_session(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult {
    s.runtime.export_session(id).map(Json).map_err(api_error)
}
async fn apply(State(s): State<AppState>, Json(input): Json<ProposalInput>) -> ApiResult {
    s.runtime
        .decide_proposal(input.proposal_id, true)
        .map(Json)
        .map_err(api_error)
}
async fn dismiss(State(s): State<AppState>, Json(input): Json<ProposalInput>) -> ApiResult {
    s.runtime
        .decide_proposal(input.proposal_id, false)
        .map(Json)
        .map_err(api_error)
}

async fn stage_edit(State(s): State<AppState>, Json(input): Json<ManualEdit>) -> ApiResult {
    s.runtime.stage_edit(input).map(Json).map_err(api_error)
}
async fn tasks(State(s): State<AppState>) -> ApiResult {
    s.runtime.active_tasks().map(Json).map_err(api_error)
}
async fn cancel(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult {
    s.runtime.cancel_chat(id).map(Json).map_err(api_error)
}
async fn chat(State(s): State<AppState>, Json(input): Json<ChatInput>) -> ApiResult {
    s.runtime
        .chat(
            input.request_id,
            input.session_id,
            input.mode,
            input.message,
            input.context_path,
        )
        .await
        .map(Json)
        .map_err(api_error)
}

async fn chat_stream(
    State(s): State<AppState>,
    Json(input): Json<ChatInput>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let (sender, receiver) = tokio::sync::mpsc::channel::<Value>(256);
    tokio::spawn(async move {
        let progress_sender = sender.clone();
        let emit = Arc::new(move |event| {
            let _ = progress_sender.try_send(json!({"type":"progress","progress":event}));
        });
        let request_id = input.request_id.clone();
        let work = s.runtime.chat_with_events(
            input.request_id,
            input.session_id,
            input.mode,
            input.message,
            input.context_path,
            emit,
        );
        tokio::pin!(work);
        let result = tokio::select! {
            biased;
            result = &mut work => result,
            _ = sender.closed() => {
                let _ = s.runtime.cancel_chat(request_id);
                let _ = work.await;
                return;
            },
        };
        let event = match result {
            Ok(reply) => json!({"type":"done","reply":reply}),
            Err(error) => json!({"type":"error","error":error}),
        };
        let _ = sender.send(event).await;
    });
    let events = stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|value| (Ok(Event::default().data(value.to_string())), receiver))
    });
    Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use tower::ServiceExt;

    fn fixture(remote: bool) -> (tempfile::TempDir, Router) {
        let dir = tempfile::tempdir().unwrap();
        let runtime =
            AgentRuntime::for_workspace(dir.path().join(".exm-code"), dir.path().to_path_buf())
                .unwrap();
        let security = SecurityConfig::new(
            "127.0.0.1".parse().unwrap(),
            remote.then(|| "a".repeat(32)),
            vec!["https://code.example.com".into()],
        )
        .unwrap();
        let app = app_router(AppState {
            runtime: Arc::new(runtime),
            security: Arc::new(security),
        });
        (dir, app)
    }

    async fn call(app: &Router, method: &str, path: &str, payload: Value) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", "127.0.0.1:4180")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(json!(null)),
        )
    }

    #[tokio::test]
    async fn session_management_export_and_delete() {
        let (_dir, app) = fixture(false);
        let (_, session) = call(&app, "POST", "/api/sessions", json!({"mode":"spec"})).await;
        let path = format!("/api/sessions/{}", session["id"].as_str().unwrap());
        let (status, updated) = call(
            &app,
            "PUT",
            &path,
            json!({"title":"A real task","pinned":true,"archived":true}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(updated["mode"], "spec");
        assert_eq!(updated["pinned"], true);
        let (_, export) = call(&app, "GET", &format!("{path}/export"), Value::Null).await;
        assert!(export["markdown"].as_str().unwrap().contains("A real task"));
        assert_eq!(
            call(&app, "DELETE", &path, Value::Null).await.0,
            StatusCode::OK
        );
        assert_eq!(
            call(&app, "GET", &format!("{path}/messages"), Value::Null)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn remote_security_and_cors() {
        let (_dir, app) = fixture(true);
        assert_eq!(
            call(&app, "GET", "/api/sessions", Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
        for (origin, status) in [
            ("https://code.example.com", StatusCode::OK),
            ("https://attacker.example", StatusCode::FORBIDDEN),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/sessions")
                        .header("authorization", format!("Bearer {}", "a".repeat(32)))
                        .header("origin", origin)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
        let response = app
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/api/sessions/test")
                    .header("origin", "https://code.example.com")
                    .header("access-control-request-method", "DELETE")
                    .header(
                        "access-control-request-headers",
                        "authorization,content-type",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://code.example.com"
        );
    }

    #[test]
    fn invalid_security_configs_fail_closed() {
        let remote = "0.0.0.0".parse().unwrap();
        assert!(SecurityConfig::new(remote, None, vec![]).is_err());
        assert!(SecurityConfig::new(
            remote,
            Some(String::new()),
            vec!["https://app.example".into()]
        )
        .is_err());
        for origin in [
            "*",
            "https://app.example/path",
            "https://user@app.example",
            "https://app.example#fragment",
            "tauri://evil",
        ] {
            assert!(
                SecurityConfig::new(remote, Some("a".repeat(32)), vec![origin.into()]).is_err(),
                "{origin}"
            );
        }
        assert!(SecurityConfig::new(
            remote,
            Some("a".repeat(32)),
            vec!["tauri://localhost".into()]
        )
        .is_ok());
    }

    #[tokio::test]
    async fn local_security_blocks_foreign_origins_and_dns_rebinding() {
        let (_dir, app) = fixture(false);
        for (host, origin) in [
            ("evil.example", "http://127.0.0.1"),
            ("localhost", "https://evil.example"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/settings")
                        .header("host", host)
                        .header("origin", origin)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }
}
