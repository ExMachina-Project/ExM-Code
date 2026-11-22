mod agent;
mod workspace;

pub use agent::{
    Agent, AgentConfig, AgentError, AgentEvent, AgentReply, ChatRole, ChatTurn, FileProposal,
    ProposalStatus, WorkflowMode,
};
pub use workspace::{FileEntry, Workspace, WorkspaceError};

#[cfg(test)]
mod agent_tests;
