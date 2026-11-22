use crate::{Agent, AgentConfig, AgentError, ProposalStatus, WorkflowMode, Workspace};
use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

type Script = Arc<Mutex<(VecDeque<Value>, Vec<Value>)>>;

struct MockModel {
    script: Script,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for MockModel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn respond(State(script): State<Script>, Json(input): Json<Value>) -> Json<Value> {
    let mut script = script.lock().unwrap();
    script.1.push(input);
    Json(script.0.pop_front().expect("unexpected provider call"))
}

async fn mock_model(responses: Vec<Value>) -> (Agent, MockModel) {
    let script = Arc::new(Mutex::new((responses.into(), Vec::new())));
    let app = Router::new()
        .route("/v1/chat/completions", post(respond))
        .with_state(script.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let agent = Agent::new(AgentConfig {
        base_url: format!("http://{address}/v1"),
        model: "test-model".into(),
        api_key: String::new(),
    })
    .unwrap();
    (agent, MockModel { script, task })
}

fn tool(name: &str, arguments: Value) -> Value {
    json!({"choices":[{"message":{"content":null,"tool_calls":[{"id":"call_test","type":"function","function":{"name":name,"arguments":arguments.to_string()}}]}}]})
}
fn answer() -> Value {
    json!({"choices":[{"message":{"content":"Review the result.","tool_calls":null}}]})
}

#[tokio::test]
async fn code_stages_new_files_without_writing_and_serializes_tool_results() {
    let (agent, model) = mock_model(vec![
        tool(
            "propose_change",
            json!({"path":"new.txt","content":"review me","reason":"test"}),
        ),
        answer(),
    ])
    .await;
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::new(directory.path()).unwrap();
    let reply = agent
        .respond(WorkflowMode::Code, "Create a file", &[], &workspace)
        .await
        .unwrap();
    assert_eq!(reply.proposals.len(), 1);
    assert_eq!(reply.proposals[0].status, ProposalStatus::Pending);
    assert!(!reply.proposals[0].base_exists);
    assert!(workspace.snapshot("new.txt").unwrap().is_none());
    let requests = model.script.lock().unwrap();
    let messages = requests.1[1]["messages"].as_array().unwrap();
    assert!(messages.iter().any(|message| message["role"] == "tool"
        && message["content"].as_str().unwrap().contains("staged")));
    assert_eq!(messages[2]["tool_calls"][0]["type"], "function");
}

#[tokio::test]
async fn plan_spec_goal_reject_unadvertised_write_tools() {
    for mode in [WorkflowMode::Plan, WorkflowMode::Spec, WorkflowMode::Goal] {
        let (agent, model) = mock_model(vec![
            tool(
                "propose_change",
                json!({"path":"new.txt","content":"no","reason":"unexpected tool"}),
            ),
            answer(),
        ])
        .await;
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::new(directory.path()).unwrap();
        let reply = agent
            .respond(mode, "Explain the project", &[], &workspace)
            .await
            .unwrap();
        assert!(reply.proposals.is_empty());
        let script = model.script.lock().unwrap();
        assert_eq!(script.1[0]["tools"].as_array().unwrap().len(), 3);
        let results = script.1[1]["messages"].as_array().unwrap();
        assert!(results.last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("read-only"));
        assert!(!directory.path().join("new.txt").exists());
    }
}

#[tokio::test]
async fn existing_file_must_be_read_before_proposal() {
    let change = json!({"path":"main.rs","content":"reviewed","reason":"test"});
    let (agent, model) = mock_model(vec![
        tool("propose_change", change.clone()),
        tool("read_file", json!({"path":"main.rs"})),
        tool("propose_change", change),
        answer(),
    ])
    .await;
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("main.rs"), "original").unwrap();
    let workspace = Workspace::new(directory.path()).unwrap();
    let reply = agent
        .respond(WorkflowMode::Code, "Review this file", &[], &workspace)
        .await
        .unwrap();
    assert_eq!(reply.proposals[0].base_content, "original");
    assert!(reply.proposals[0].base_exists);
    assert_eq!(workspace.read("main.rs", 100).unwrap(), "original");
    assert!(model.script.lock().unwrap().1[1]["messages"]
        .to_string()
        .contains("Read this existing file"));
}

#[tokio::test]
async fn endless_tool_calls_stop_at_round_limit() {
    let responses = (0..8)
        .map(|_| tool("list_files", json!({"path":""})))
        .collect();
    let (agent, _model) = mock_model(responses).await;
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::new(directory.path()).unwrap();
    assert!(matches!(
        agent
            .respond(WorkflowMode::Code, "Inspect", &[], &workspace)
            .await,
        Err(AgentError::RoundLimit)
    ));
}
