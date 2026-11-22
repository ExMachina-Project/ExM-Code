use clap::{Parser, Subcommand};
use std::{
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
};

#[derive(Parser)]
#[command(name = "exm-code", version, about = "A workflow-native coding agent")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Start the headless Agent API server.
    Serve {
        /// Server-side project directory exposed to the agent.
        #[arg(default_value = ".")]
        workspace: PathBuf,
        /// Network interface to bind. Non-loopback binds require authentication.
        #[arg(long, default_value = "127.0.0.1")]
        listen: IpAddr,
        /// HTTP port.
        #[arg(short, long, default_value_t = 4180)]
        port: u16,
        /// Shared bearer token for non-loopback API access (or EXM_CODE_AUTH_TOKEN).
        #[arg(long)]
        auth_token: Option<String>,
        /// Allowed browser origin; repeat for more origins.
        #[arg(long = "allowed-origin", action = clap::ArgAction::Append)]
        allowed_origins: Vec<String>,
    },
    /// Print the active workspace path.
    Info {
        #[arg(default_value = ".")]
        workspace: PathBuf,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command.unwrap_or(Command::Serve {
        workspace: PathBuf::from("."),
        listen: IpAddr::V4(Ipv4Addr::LOCALHOST),
        port: 4180,
        auth_token: None,
        allowed_origins: Vec::new(),
    }) {
        Command::Serve {
            workspace,
            listen,
            port,
            auth_token,
            allowed_origins,
        } => {
            let workspace = std::fs::canonicalize(workspace)?;
            let auth_token = auth_token.or_else(|| std::env::var("EXM_CODE_AUTH_TOKEN").ok());
            exm_code_server::serve(workspace, listen, port, auth_token, allowed_origins).await?;
        }
        Command::Info { workspace } => println!("{}", std::fs::canonicalize(workspace)?.display()),
    }
    Ok(())
}
